import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AcpUsageProbeError, runAcpUsageProbe } from "./usage-probe.js";

// A minimal ACP agent over stdio. MODE picks its behaviour; it logs every
// request method to LOG so tests can tell whether a prompt was ever sent.
const FAKE_AGENT = String.raw`
const fs = require("node:fs");
const mode = process.env.FAKE_MODE || "ok";
const log = (line) => process.env.FAKE_LOG && fs.appendFileSync(process.env.FAKE_LOG, line + "\n");
log("cwd " + process.cwd());
const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let n;
  while ((n = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, n);
    buf = buf.slice(n + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (!msg.method) continue;
    log("req " + msg.method);
    if (mode === "silent") continue;
    if (msg.method === "initialize") {
      send({ id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
    } else if (msg.method === "session/new") {
      if (mode === "logged-out") {
        send({ id: msg.id, error: { code: -32000, message: "Authentication required" } });
        continue;
      }
      send({ id: msg.id, result: { sessionId: "s1" } });
      const names = mode === "no-command" ? ["plan", "review"] : ["plan", "stats"];
      send({ method: "session/update", params: { sessionId: "s1", update: {
        sessionUpdate: "available_commands_update",
        availableCommands: names.map((name) => ({ name, description: name })),
      } } });
    } else if (msg.method === "session/prompt") {
      const text = msg.params.prompt[0].text;
      log("prompt " + text);
      if (mode === "crash") process.exit(3);
      send({ id: 99, method: "session/request_permission", params: { sessionId: "s1" } });
      send({ method: "session/update", params: { sessionId: "s1", update: {
        sessionUpdate: "agent_message_chunk", content: { type: "text", text: "- License: Plan X\n" },
      } } });
      send({ method: "session/update", params: { sessionId: "s1", update: {
        sessionUpdate: "agent_message_chunk", content: { type: "text", text: "- Balance left: 9.5 credits\n" },
      } } });
      send({ id: msg.id, result: { stopReason: "end_turn" } });
    } else if (msg.method === "session/close") {
      send({ id: msg.id, result: {} });
    }
  }
});
`;

let dir: string;
let script: string;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "acp-usage-probe-test-"));
  script = path.join(dir, "fake-agent.cjs");
  await fs.writeFile(script, FAKE_AGENT);
});

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function probe(mode: string, options: { command?: string; timeoutMs?: number } = {}) {
  const log = path.join(dir, `${mode}-${Math.random().toString(36).slice(2)}.log`);
  const run = runAcpUsageProbe({
    argv: [process.execPath, script],
    ...(options.command ? { command: options.command } : {}),
    timeoutMs: options.timeoutMs ?? 10_000,
    env: { ...process.env, FAKE_MODE: mode, FAKE_LOG: log },
    commandsWaitMs: 500,
  });
  const readLog = async () => (await fs.readFile(log, "utf8").catch(() => "")).split("\n");
  return { run, readLog };
}

describe("runAcpUsageProbe", () => {
  it("sends the advertised usage command, collects the reply and closes the session", async () => {
    const { run, readLog } = await probe("ok");
    await expect(run).resolves.toBe("- License: Plan X\n- Balance left: 9.5 credits\n");
    const log = await readLog();
    expect(log).toContain("prompt /stats");
    expect(log).toContain("req session/close");
    // The agent ran in a throwaway directory that is gone afterwards.
    const cwd = log.find((line) => line.startsWith("cwd "))?.slice(4) ?? "";
    expect(path.basename(cwd)).toMatch(/^openclaw-acp-usage-/);
    await expect(fs.stat(cwd)).rejects.toThrow();
  });

  it("uses a configured command only when the agent advertises it", async () => {
    const { run, readLog } = await probe("ok", { command: "/usage" });
    await expect(run).rejects.toMatchObject({ reason: "unsupported" });
    expect((await readLog()).some((line) => line.startsWith("prompt"))).toBe(false);
  });

  it("never prompts an agent without a usage command", async () => {
    const { run, readLog } = await probe("no-command");
    await expect(run).rejects.toThrow("does not advertise /usage or /stats");
    expect((await readLog()).some((line) => line.startsWith("prompt"))).toBe(false);
  });

  it("reports a logged-out agent", async () => {
    const { run } = await probe("logged-out");
    await expect(run).rejects.toMatchObject({
      reason: "logged-out",
      message: "The agent is not logged in",
    });
  });

  it("times out an agent that never answers", async () => {
    const { run } = await probe("silent", { timeoutMs: 1000 });
    await expect(run).rejects.toMatchObject({ reason: "timeout" });
  });

  it("reports an agent that exits mid-turn", async () => {
    const { run } = await probe("crash");
    await expect(run).rejects.toThrow("The agent exited (code 3)");
  });

  it("reports a missing agent command", async () => {
    const run = runAcpUsageProbe({
      argv: [path.join(dir, "no-such-agent")],
      timeoutMs: 5000,
    });
    await expect(run).rejects.toBeInstanceOf(AcpUsageProbeError);
    await expect(run).rejects.toMatchObject({ reason: "not-installed" });
  });
});
