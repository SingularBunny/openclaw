import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import { AcpUsageProbeError, type AcpUsageProbeParams } from "./usage-probe.js";
import {
  createAcpAgentUsageSource,
  resolveUsageProbeEnv,
  resolveUsageProbeTargets,
} from "./usage-source.js";

const REPLY =
  "**License & quota**\n- License: Example AI Ultimate\n- Balance left: 42.50 credits\n";

function config(usage: Record<string, unknown> = { command: "stats" }, extra = {}) {
  return {
    agents: {
      junie: { command: "/opt/agent/bin/junie", args: ["--acp=true"], usage },
      other: { command: "other-agent" },
    },
    ...extra,
  };
}

function collect(
  source: ReturnType<typeof createAcpAgentUsageSource>,
  rawConfig: unknown,
  timeoutMs = 1000,
) {
  return source.collect({
    rawConfig,
    env: { PATH: "/bin" },
    signal: new AbortController().signal,
    timeoutMs,
  });
}

describe("resolveUsageProbeTargets", () => {
  it("lists only agents that opt in, with their full command", () => {
    expect(resolveUsageProbeTargets({ rawConfig: config(), env: {} })).toEqual([
      expect.objectContaining({
        agentId: "junie",
        provider: "acp-junie",
        displayName: "Junie",
        argv: ["/opt/agent/bin/junie", "--acp=true"],
        command: "stats",
        timeoutMs: 30_000,
        cacheTtlMs: 600_000,
      }),
    ]);
    expect(resolveUsageProbeTargets({ rawConfig: { agents: {} }, env: {} })).toEqual([]);
  });

  it("names the entry from the label, then the agent identity", () => {
    const [labelled] = resolveUsageProbeTargets({
      rawConfig: config({ label: "JetBrains" }),
      env: {},
    });
    expect(labelled?.displayName).toBe("JetBrains");
    const [identity] = resolveUsageProbeTargets({
      rawConfig: config({}, { agentIdentities: { junie: { name: "Junie CLI" } } }),
      env: {},
    });
    expect(identity?.displayName).toBe("Junie CLI");
  });
});

describe("resolveUsageProbeEnv", () => {
  it("applies the agent environment allow and block lists", () => {
    const env = { PATH: "/bin", SECRET: "x", KEEP: "y", ACPX_AUTH_TOKEN: "t", LC_ALL: "C" };
    expect(resolveUsageProbeEnv(env, {})).toEqual(env);
    expect(resolveUsageProbeEnv(env, { allow: ["KEEP"] })).toEqual({
      PATH: "/bin",
      KEEP: "y",
      ACPX_AUTH_TOKEN: "t",
      LC_ALL: "C",
    });
    expect(resolveUsageProbeEnv(env, { block: ["SECRET"] })).not.toHaveProperty("SECRET");
  });
});

describe("createAcpAgentUsageSource", () => {
  it("turns the agent's reply into a balance entry that is not a model provider", async () => {
    const run = vi.fn(async (_params: AcpUsageProbeParams) => REPLY);
    const source = createAcpAgentUsageSource({ run, now: () => 1_000 });
    const snapshots = await collect(source, config());
    expect(snapshots).toEqual([
      {
        provider: "acp-junie",
        displayName: "Junie",
        windows: [],
        plan: "Example AI Ultimate",
        billing: [{ type: "balance", label: "Balance left", amount: 42.5, unit: "credits" }],
        observedAt: 1_000,
      },
    ]);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[0]).toMatchObject({
      argv: ["/opt/agent/bin/junie", "--acp=true"],
      command: "stats",
      timeoutMs: 30_000,
    });
  });

  it("serves the cached value until its TTL, then refreshes in the background with its age", async () => {
    let now = 1_000;
    const second = createDeferred<string>();
    const run = vi
      .fn<(params: AcpUsageProbeParams) => Promise<string>>()
      .mockResolvedValueOnce(REPLY)
      .mockImplementationOnce(() => second.promise);
    const source = createAcpAgentUsageSource({ run, now: () => now });
    await collect(source, config());
    now += 5 * 60_000;
    await collect(source, config());
    expect(run).toHaveBeenCalledTimes(1);

    now += 6 * 60_000;
    const stale = await collect(source, config());
    expect(stale[0]).toMatchObject({ observedAt: 1_000, refreshing: true });
    // Single flight: a second read during the refresh starts no second probe.
    await collect(source, config());
    expect(run).toHaveBeenCalledTimes(2);

    second.resolve(REPLY.replace("42.50", "40.00"));
    await vi.waitFor(async () => {
      const [fresh] = await collect(source, config());
      expect(fresh).toMatchObject({ observedAt: now, billing: [{ amount: 40 }] });
      expect(fresh).not.toHaveProperty("refreshing");
    });
  });

  it("answers a cold read before the host deadline and keeps probing", async () => {
    const probe = createDeferred<string>();
    const source = createAcpAgentUsageSource({ run: () => probe.promise, now: () => 1 });
    const [cold] = await collect(source, config(), 300);
    expect(cold).toEqual({
      provider: "acp-junie",
      displayName: "Junie",
      windows: [],
      refreshing: true,
    });
    probe.resolve(REPLY);
    await vi.waitFor(async () => {
      expect((await collect(source, config()))[0]).toHaveProperty("billing");
    });
  });

  it.each([
    [
      new AcpUsageProbeError("Agent command not found: junie", "not-installed"),
      "Agent command not found: junie",
    ],
    [
      new AcpUsageProbeError("The agent did not answer within 30s", "timeout"),
      "The agent did not answer within 30s",
    ],
    [
      new AcpUsageProbeError("The agent is not logged in", "logged-out"),
      "The agent is not logged in",
    ],
  ])("turns a probe failure into an error entry: %s", async (error, message) => {
    const source = createAcpAgentUsageSource({
      run: async () => {
        throw error;
      },
    });
    expect(await collect(source, config())).toEqual([
      { provider: "acp-junie", displayName: "Junie", windows: [], error: message },
    ]);
  });

  it("reports a logged-out or failing reply as an error entry", async () => {
    const loggedOut = createAcpAgentUsageSource({ run: async () => "Please log in first." });
    expect((await collect(loggedOut, config()))[0]).toMatchObject({
      error: "The agent is not logged in",
    });
    const empty = createAcpAgentUsageSource({ run: async () => "" });
    expect((await collect(empty, config()))[0]).toMatchObject({
      error: "The agent sent an empty reply",
    });
  });

  it("shows an own-API-key account with its plan and no balance", async () => {
    const source = createAcpAgentUsageSource({
      run: async () => "**License & quota**\n- License: Own keys\n",
    });
    const [entry] = await collect(source, config());
    expect(entry).toMatchObject({ plan: "Own keys", windows: [] });
    expect(entry).not.toHaveProperty("billing");
    expect(entry).not.toHaveProperty("error");
  });

  it("keeps the last good balance when a later probe fails", async () => {
    let now = 0;
    const run = vi
      .fn<(params: AcpUsageProbeParams) => Promise<string>>()
      .mockResolvedValueOnce(REPLY)
      .mockRejectedValueOnce(new AcpUsageProbeError("timed out", "timeout"));
    const source = createAcpAgentUsageSource({ run, now: () => now });
    await collect(source, config());
    now = 11 * 60_000;
    await collect(source, config());
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    await vi.waitFor(async () => {
      const [entry] = await collect(source, config());
      expect(entry).toMatchObject({ observedAt: 0, billing: [{ amount: 42.5 }] });
      expect(entry).not.toHaveProperty("refreshing");
    });
  });

  it("probes again after invalidation or a changed agent command", async () => {
    const run = vi.fn(async (_params: AcpUsageProbeParams) => REPLY);
    const source = createAcpAgentUsageSource({ run, now: () => 0 });
    await collect(source, config());
    source.invalidate("junie");
    await collect(source, config());
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    await collect(source, config({ command: "usage" }));
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(3));
  });

  it("aborts running probes on dispose and stops answering", async () => {
    let signal: AbortSignal | undefined;
    const source = createAcpAgentUsageSource({
      run: (params) => {
        signal = params.signal;
        return new Promise(() => {});
      },
    });
    await collect(source, config(), 50);
    source.dispose();
    expect(signal?.aborted).toBe(true);
    expect(await collect(source, config())).toEqual([]);
  });
});
