import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getGatewayRestartNotice,
  resetGatewayRestartNoticeForTest,
  setGatewayRestartNoticeBroadcaster,
  type GatewayRestartNoticeEventPayload,
} from "../../gateway/restart-notice.js";
import type { GatewayActiveWorkSnapshot } from "../../infra/gateway-active-work.js";
import {
  resolveAgentTurnDrainMs,
  resolveAgentTurnShutdownLimitMs,
  startAgentTurnShutdownWait,
} from "./run-loop-agent-turn-wait.js";

const ENV = "OPENCLAW_RESTART_AGENT_RUN_WAIT_MS";

type Work = { turns: number; replies: number; other: number };

function snapshotOf(work: Work): GatewayActiveWorkSnapshot {
  const counts = {
    agentRuns: work.turns,
    embeddedRuns: work.turns,
    acpRuns: 0,
    chatRuns: 0,
    pendingReplies: work.replies,
    backgroundExecSessions: work.other,
    totalActive: work.turns * 2 + work.replies + work.other,
  };
  return { idle: counts.totalActive === 0, counts } as unknown as GatewayActiveWorkSnapshot;
}

describe("shutdown limits for the agent-turn wait", () => {
  it("raises the shutdown limit only when the wait is configured above upstream's 5 minutes", () => {
    expect(resolveAgentTurnShutdownLimitMs({})).toBeUndefined();
    expect(resolveAgentTurnShutdownLimitMs({ [ENV]: "300000" })).toBeUndefined();
    expect(resolveAgentTurnShutdownLimitMs({ [ENV]: "soon" })).toBeUndefined();
    expect(resolveAgentTurnShutdownLimitMs({ [ENV]: "1800000" })).toBe(1_810_000);
    // Just above the deferral budget stays at upstream's fixed limit.
    expect(resolveAgentTurnShutdownLimitMs({ [ENV]: "300001" })).toBe(325_000);
    expect(resolveAgentTurnShutdownLimitMs({ [ENV]: "unlimited" })).toBe(2_147_483_647);
  });

  it("waits for agent turns past upstream's drain, within the bound and the shutdown budget", () => {
    const budget = { timeoutMs: 1_810_000, reserveMs: 10_000 };
    const env = { [ENV]: "1800000" };
    expect(
      resolveAgentTurnDrainMs({ budget, elapsedMs: 0, upstreamDrainMs: 20_000, skip: false, env }),
    ).toBe(1_800_000);
    // Counted from the accepted request.
    expect(
      resolveAgentTurnDrainMs({
        budget,
        elapsedMs: 1_000,
        upstreamDrainMs: 20_000,
        skip: false,
        env,
      }),
    ).toBe(1_799_000);
    // A native stop deadline that leaves less than the bound wins.
    expect(
      resolveAgentTurnDrainMs({
        budget: { timeoutMs: 325_000, reserveMs: 10_000 },
        elapsedMs: 0,
        upstreamDrainMs: 20_000,
        skip: false,
        env,
      }),
    ).toBe(315_000);
    // Nothing to add over upstream's drain, skipped requests, unset wait, drains without timeout.
    expect(
      resolveAgentTurnDrainMs({
        budget: { timeoutMs: 310_000, reserveMs: 10_000 },
        elapsedMs: 0,
        upstreamDrainMs: 300_000,
        skip: false,
        env,
      }),
    ).toBeUndefined();
    expect(
      resolveAgentTurnDrainMs({ budget, elapsedMs: 0, upstreamDrainMs: 20_000, skip: true, env }),
    ).toBeUndefined();
    expect(
      resolveAgentTurnDrainMs({
        budget,
        elapsedMs: 0,
        upstreamDrainMs: 20_000,
        skip: false,
        env: {},
      }),
    ).toBeUndefined();
    expect(
      resolveAgentTurnDrainMs({
        budget,
        elapsedMs: 0,
        upstreamDrainMs: undefined,
        skip: false,
        env,
      }),
    ).toBeUndefined();
  });
});

describe("agent-turn shutdown wait", () => {
  let events: GatewayRestartNoticeEventPayload[];
  let signals: EventEmitter;
  let work: Work;
  const logger = { info: vi.fn(), warn: vi.fn() };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    resetGatewayRestartNoticeForTest();
    events = [];
    setGatewayRestartNoticeBroadcaster((payload) => events.push(payload));
    signals = new EventEmitter();
    work = { turns: 1, replies: 1, other: 0 };
    logger.info.mockReset();
    logger.warn.mockReset();
  });
  afterEach(() => {
    resetGatewayRestartNoticeForTest();
    vi.useRealTimers();
  });

  const start = (action: "stop" | "restart", deadlineAt = 1_000_000 + 1_800_000) =>
    startAgentTurnShutdownWait({
      action,
      reason: action === "stop" ? "stop (SIGTERM)" : "restart (SIGUSR2: installation replaced)",
      deadlineAt,
      inspect: () => snapshotOf(work),
      logger,
      signals,
      pollMs: 1_000,
      noticePollMs: 1_000,
    });

  it("keeps a stop waiting past upstream's 20 s while a turn runs, then drains", async () => {
    const wait = start("stop");
    let result: Awaited<ReturnType<typeof wait.wait>> | undefined;
    void wait.wait(20_000).then((r) => (result = r));
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(result).toBeUndefined();
    expect(getGatewayRestartNotice()).toMatchObject({
      phase: "stopping",
      reason: "stop (SIGTERM)",
      deadlineAt: 1_000_000 + 1_800_000,
      activeTurns: 1,
    });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("waiting for 1 running"));
    work = { turns: 0, replies: 0, other: 0 };
    await vi.advanceTimersByTimeAsync(1_000);
    expect(result?.drained).toBe(true);
    wait.finish();
    expect(getGatewayRestartNotice()).toBeNull();
    expect(signals.listenerCount("SIGTERM")).toBe(0);
    expect(signals.listenerCount("SIGQUIT")).toBe(0);
  });

  it("ends once turns and their replies finish, leaving other work to upstream's cut", async () => {
    work = { turns: 1, replies: 1, other: 1 };
    const wait = start("stop");
    let result: Awaited<ReturnType<typeof wait.wait>> | undefined;
    void wait.wait(20_000).then((r) => (result = r));
    await vi.advanceTimersByTimeAsync(60_000);
    work = { turns: 0, replies: 1, other: 1 };
    await vi.advanceTimersByTimeAsync(5_000);
    expect(result).toBeUndefined();
    work = { turns: 0, replies: 0, other: 1 };
    await vi.advanceTimersByTimeAsync(1_000);
    expect(result?.drained).toBe(false);
    wait.finish();
  });

  it("gives up at the deadline", async () => {
    const wait = start("stop", 1_000_000 + 60_000);
    let result: Awaited<ReturnType<typeof wait.wait>> | undefined;
    void wait.wait(20_000).then((r) => (result = r));
    await vi.advanceTimersByTimeAsync(59_000);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(result?.drained).toBe(false);
    wait.finish();
  });

  it("a second stop signal forces a stop at once", async () => {
    const wait = start("stop");
    let result: Awaited<ReturnType<typeof wait.wait>> | undefined;
    void wait.wait(20_000).then((r) => (result = r));
    await vi.advanceTimersByTimeAsync(60_000);
    signals.emit("SIGINT");
    await vi.advanceTimersByTimeAsync(0);
    expect(result?.drained).toBe(false);
    expect(wait.forced).toBe(true);
    wait.finish();
  });

  it("a restart drain becomes a stop on the first SIGTERM and is forced by the second", async () => {
    const wait = start("restart");
    let result: Awaited<ReturnType<typeof wait.wait>> | undefined;
    void wait.wait(300_000).then((r) => (result = r));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(getGatewayRestartNotice()?.phase).toBe("draining");
    signals.emit("SIGTERM");
    await vi.advanceTimersByTimeAsync(400_000);
    expect(result).toBeUndefined();
    expect(getGatewayRestartNotice()?.phase).toBe("stopping");
    signals.emit("SIGTERM");
    await vi.advanceTimersByTimeAsync(0);
    expect(result?.drained).toBe(false);
    wait.finish();
    // Turned into a stop: the notice ends with the disconnect instead of "restarting".
    expect(events.at(-1)).toEqual({ notice: null });
  });

  it("SIGQUIT forces at once; a finished restart drain announces the restart", async () => {
    const wait = start("restart");
    let result: Awaited<ReturnType<typeof wait.wait>> | undefined;
    void wait.wait(300_000).then((r) => (result = r));
    await vi.advanceTimersByTimeAsync(1_000);
    signals.emit("SIGQUIT");
    await vi.advanceTimersByTimeAsync(0);
    expect(result?.drained).toBe(false);
    wait.finish();
    expect(getGatewayRestartNotice()?.phase).toBe("restarting");
    // After finish the listeners are gone: signals go back to their usual owners.
    expect(signals.listenerCount("SIGQUIT")).toBe(0);
  });

  it("publishes nothing when only non-agent work drains", async () => {
    work = { turns: 0, replies: 0, other: 1 };
    const wait = start("stop");
    let result: Awaited<ReturnType<typeof wait.wait>> | undefined;
    void wait.wait(20_000).then((r) => (result = r));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(result?.drained).toBe(false);
    expect(events).toEqual([]);
    wait.finish();
  });
});
