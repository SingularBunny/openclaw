// Fork (F49): plan mode on a warm Claude CLI process, against a fixture that keeps native mode
// state like Claude Code 2.1.302: set_permission_mode applies when read, ExitPlanMode is
// validated against the mode after its PreToolUse decision and then leaves plan mode itself.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  CliBackendExecuteContext,
  CliBackendLiveSessionCapability,
  CliBackendLiveSessionHandle,
} from "openclaw/plugin-sdk/cli-backend";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLAUDE_CLI_PLAN_OPTIONS } from "./cli-permission-mode.js";
import { executeClaudeCli } from "./cli.runtime.js";

const roots: string[] = [];
const handles = new Set<CliBackendLiveSessionHandle>();
afterEach(async () => {
  for (const handle of handles) {
    handle.close("restart");
    await handle.waitForExit();
  }
  handles.clear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const fixture = String.raw`
import { createInterface } from "node:readline";
const send = (record) => process.stdout.write(JSON.stringify(record) + "\n");
const argv = process.argv.slice(2);
const turns = JSON.parse(process.env.FIXTURE_TURNS);
let mode = argv[argv.indexOf("--permission-mode") + 1];
let prePlanMode;
let turn = -1;
let log = [];
let queue = [];
let waiting;
function nextTool() {
  const call = queue.shift();
  if (!call) {
    // Leave room for control requests the runtime sends after the last tool result.
    setTimeout(() => {
      send({ type: "result", subtype: "success", session_id: "native-plan", num_turns: 1,
        stop_reason: "end_turn", result: JSON.stringify({ log, mode }) });
      log = [];
    }, 300);
    return;
  }
  waiting = { ...call, id: "tool-" + turn + "-" + log.length };
  send({ type: "control_request", request_id: "pre-" + waiting.id, request: { subtype: "hook_callback",
    callback_id: "PreToolUse", tool_use_id: waiting.id, input: { hook_event_name: "PreToolUse",
      tool_name: call.tool, tool_input: call.input, tool_use_id: waiting.id, cwd: process.cwd() } } });
}
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.type === "control_request") {
    if (message.request.subtype === "set_permission_mode") {
      if (message.request.mode === "plan" && mode !== "plan") prePlanMode = mode;
      mode = message.request.mode;
      log.push({ event: "set_permission_mode", mode });
    }
    send({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: {} } });
  } else if (message.type === "user") {
    turn++;
    log.push({ event: "prompt", mode });
    queue = [...turns[turn]];
    nextTool();
  } else if (message.type === "control_response" && waiting &&
      message.response.request_id === "pre-" + waiting.id) {
    const call = waiting;
    waiting = undefined;
    const hook = message.response.response.hookSpecificOutput;
    let error = hook.permissionDecision === "allow" ? undefined : hook.permissionDecisionReason;
    if (!error && call.tool === "ExitPlanMode") {
      if (mode !== "plan") {
        error = "You are not in plan mode.";
      } else {
        mode = prePlanMode ?? "default";
      }
    }
    log.push({ event: "tool", tool: call.tool, error: error ?? null });
    send({ type: "user", message: { role: "user", content: [{ type: "tool_result",
      tool_use_id: call.id, content: error ?? "ok", ...(error ? { is_error: true } : {}) }] },
      parent_tool_use_id: null });
    nextTool();
  }
}
`;

function createLiveSession(): CliBackendLiveSessionCapability {
  let current: CliBackendLiveSessionHandle | undefined;
  return {
    fingerprint: "plan-mode-native-fixture",
    current: () => current,
    restart: async () => {
      current?.close("restart");
      await current?.waitForExit();
    },
    register: (handle) => {
      current = handle;
      handles.add(handle);
    },
    activate: () => {},
    remove: (handle) => {
      if (current === handle) {
        current = undefined;
      }
    },
  };
}

type Call = { tool: string; input: Record<string, unknown> };
type Detail = { log: Array<Record<string, unknown>>; mode: string };

async function setup(turnsFor: (root: string) => Call[][]) {
  const root = await mkdtemp(path.join(os.tmpdir(), "openclaw-claude-native-plan-"));
  roots.push(root);
  const turns = turnsFor(root);
  const script = path.join(root, "claude.mjs");
  await writeFile(script, fixture);
  const liveSession = createLiveSession();
  const turn = async (overrides: Partial<CliBackendExecuteContext> = {}) => {
    const context: CliBackendExecuteContext = {
      command: process.execPath,
      args: [script],
      cwd: root,
      env: { PATH: process.env.PATH ?? "", HOME: root, FIXTURE_TURNS: JSON.stringify(turns) },
      prompt: "append a third line to notes.txt",
      systemPrompt: "synthetic operator instructions",
      modelId: "claude-sonnet-4-6",
      useResume: false,
      liveSession,
      timeoutMs: 10_000,
      abortSignal: AbortSignal.timeout(10_000),
      requestToolPermission: vi.fn<CliBackendExecuteContext["requestToolPermission"]>(
        async (request) => ({ behavior: "allow", updatedInput: request.toolInput }),
      ),
      requestUserInput: vi.fn<CliBackendExecuteContext["requestUserInput"]>(async () => ({
        status: "cancelled",
        message: "No question expected.",
      })),
      ...overrides,
    };
    const records: Record<string, unknown>[] = [];
    for await (const record of executeClaudeCli(context)) {
      records.push(record);
    }
    const result = records.findLast((record) => record.type === "result");
    return { context, detail: JSON.parse(String(result?.result)) as Detail };
  };
  return { root, turn };
}

const approveWith = (answer: string) =>
  vi.fn<CliBackendExecuteContext["requestUserInput"]>(async () => ({
    status: "answered",
    answers: { plan_approval: [answer] },
  }));

describe("Claude CLI plan mode on a warm process", () => {
  it("enters plan mode before the prompt, writes the plan file, and exits after approval", async () => {
    const planFile = (root: string) =>
      path.join(root, ".claude", "plans", "append-a-line-giggly-peacock.md");
    const { root, turn } = await setup((dir) => [
      [],
      [
        { tool: "Write", input: { file_path: planFile(dir), content: "# Plan" } },
        { tool: "Write", input: { file_path: path.join(dir, "notes.md"), content: "line three" } },
        { tool: "ExitPlanMode", input: {} },
      ],
    ]);
    // The first turn starts the warm process with no explicit mode ("Not set").
    const first = await turn();
    expect(first.detail.log).toEqual([{ event: "prompt", mode: "default" }]);

    const onPermissionModeChange = vi.fn(async () => {});
    const second = await turn({
      permissionMode: "plan",
      requestUserInput: approveWith(CLAUDE_CLI_PLAN_OPTIONS.acceptEdits),
      onPermissionModeChange,
    });

    expect(second.detail.log).toEqual([
      // Written ahead of the prompt on the same stdin, so the prompt runs in plan mode.
      { event: "set_permission_mode", mode: "plan" },
      { event: "prompt", mode: "plan" },
      { event: "tool", tool: "Write", error: null },
      { event: "tool", tool: "Write", error: expect.stringContaining("Plan mode is on") },
      // Native still is in plan mode when it checks ExitPlanMode; the choice follows its result.
      { event: "tool", tool: "ExitPlanMode", error: null },
      { event: "set_permission_mode", mode: "acceptEdits" },
    ]);
    expect(second.detail.mode).toBe("acceptEdits");
    expect(onPermissionModeChange).toHaveBeenCalledWith("acceptEdits");
    const permissionCalls = vi.mocked(second.context.requestToolPermission).mock.calls;
    expect(permissionCalls.map(([request]) => request.toolInput.file_path)).toEqual([
      planFile(root),
    ]);
  });

  it("restates the session mode at the next turn", async () => {
    const { turn } = await setup(() => [[{ tool: "ExitPlanMode", input: {} }], []]);
    await turn({
      permissionMode: "plan",
      requestUserInput: approveWith(CLAUDE_CLI_PLAN_OPTIONS.default),
    });
    const next = await turn({ permissionMode: "acceptEdits" });

    expect(next.detail.log).toEqual([
      { event: "set_permission_mode", mode: "acceptEdits" },
      { event: "prompt", mode: "acceptEdits" },
    ]);
  });
});
