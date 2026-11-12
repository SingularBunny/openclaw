import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getGatewayRestartNotice,
  resetGatewayRestartNoticeForTest,
  setGatewayRestartNoticeBroadcaster,
  trackGatewayRestartDeferral,
  type GatewayRestartNoticeEventPayload,
} from "../../gateway/restart-notice.js";
import type { GatewayActiveWorkSnapshot } from "../../infra/gateway-active-work.js";
import {
  resolveAgentTurnShutdownLimitMs,
  waitForAgentTurnsBeforeShutdown,
  type AgentTurnWaitOutcome,
} from "./run-loop-agent-turn-wait.js";
import type { GatewayRunSignalRequest } from "./run-loop-request.js";

const ENV = "OPENCLAW_RESTART_AGENT_RUN_WAIT_MS";
const T0 = 1_000_000;

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
  const blockers = [
    ...(work.turns
      ? [
          {
            kind: "embedded-run",
            count: work.turns,
            message: `${work.turns} active embedded run(s)`,
          },
        ]
      : []),
    ...(work.other
      ? [{ kind: "background-exec", count: work.other, message: `${work.other} exec` }]
      : []),
  ];
  return {
    idle: counts.totalActive === 0,
    counts,
    blockers,
  } as unknown as GatewayActiveWorkSnapshot;
}

describe("shutdown limit for the agent-turn wait", () => {
  it("raises the shutdown limit only when the wait is configured above upstream's 5 minutes", () => {
    expect(resolveAgentTurnShutdownLimitMs({})).toBeUndefined();
    expect(resolveAgentTurnShutdownLimitMs({ [ENV]: "300000" })).toBeUndefined();
    expect(resolveAgentTurnShutdownLimitMs({ [ENV]: "soon" })).toBeUndefined();
    expect(resolveAgentTurnShutdownLimitMs({ [ENV]: "1800000" })).toBe(1_810_000);
    // Just above the deferral budget stays at upstream's fixed limit.
    expect(resolveAgentTurnShutdownLimitMs({ [ENV]: "300001" })).toBe(325_000);
    expect(resolveAgentTurnShutdownLimitMs({ [ENV]: "unlimited" })).toBe(2_147_483_647);
  });
});

describe("agent-turn wait before shutdown", () => {
  let events: GatewayRestartNoticeEventPayload[];
  let signals: EventEmitter;
  let work: Work;
  const logger = { info: vi.fn(), warn: vi.fn() };
  const inspect = vi.fn(() => snapshotOf(work));

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    resetGatewayRestartNoticeForTest();
    events = [];
    setGatewayRestartNoticeBroadcaster((payload) => events.push(payload));
    signals = new EventEmitter();
    work = { turns: 1, replies: 0, other: 0 };
    logger.info.mockReset();
    logger.warn.mockReset();
    inspect.mockClear();
  });
  afterEach(() => {
    resetGatewayRestartNoticeForTest();
    vi.useRealTimers();
  });

  const start = (
    request: Partial<GatewayRunSignalRequest> & Pick<GatewayRunSignalRequest, "action">,
    opts: { env?: string; shutdownDeadline?: number } = {},
  ) => {
    const state: { outcome?: AgentTurnWaitOutcome } = {};
    void waitForAgentTurnsBeforeShutdown({
      request: { acceptedAtMs: T0, ...request },
      reason: request.action === "stop" ? "stop (SIGTERM)" : "restart (SIGUSR2)",
      shutdownDeadline: opts.shutdownDeadline,
      reserveMs: 10_000,
      logger,
      env: opts.env === undefined ? { [ENV]: "1800000" } : { [ENV]: opts.env },
      inspect,
      listSessions: () => (work.turns ? ["agent:main:main"] : []),
      trackNotice: trackGatewayRestartDeferral,
      signals,
      now: Date.now,
      pollMs: 1_000,
      noticePollMs: 1_000,
    }).then((outcome) => (state.outcome = outcome));
    return state;
  };

  it("keeps upstream's immediate close when the wait is off or the request is forced", async () => {
    const unset = start({ action: "stop" }, { env: "" });
    const forced = start({ action: "restart", restartIntent: { force: true } });
    const handoff = start({ action: "external-restart" });
    const update = start({
      action: "restart",
      restartIntent: {
        successorOwner: { kind: "managed-update-handoff", handoffId: "h", installRoot: "/x" },
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect([unset, forced, handoff, update].map((s) => s.outcome)).toEqual([
      "off",
      "off",
      "off",
      "off",
    ]);
    expect(inspect).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it("continues at once when no agent turn runs", async () => {
    work = { turns: 0, replies: 0, other: 2 };
    const state = start({ action: "stop" });
    await vi.advanceTimersByTimeAsync(0);
    expect(state.outcome).toBe("idle");
    expect(events).toEqual([]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("SIGTERM stop waits for a running turn past upstream's limits, then continues", async () => {
    const state = start(
      { action: "stop", signal: "SIGTERM" },
      { shutdownDeadline: T0 + 1_810_000 },
    );
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(state.outcome).toBeUndefined();
    expect(getGatewayRestartNotice()).toMatchObject({
      phase: "stopping",
      reason: "stop (SIGTERM)",
      deadlineAt: T0 + 1_800_000,
      activeTurns: 1,
    });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(
        /waiting up to 1800000ms for 1 running agent turn\(s\) \(1 active embedded run\(s\)\); sessions: agent:main:main before stop/,
      ),
    );
    // The turn's reply delivery still counts.
    work = { turns: 0, replies: 1, other: 1 };
    await vi.advanceTimersByTimeAsync(5_000);
    expect(state.outcome).toBeUndefined();
    work = { turns: 0, replies: 0, other: 1 };
    await vi.advanceTimersByTimeAsync(1_000);
    expect(state.outcome).toBe("idle");
    expect(getGatewayRestartNotice()).toBeNull();
    expect(events.at(-1)).toEqual({ notice: null });
    for (const signal of ["SIGTERM", "SIGINT", "SIGQUIT"]) {
      expect(signals.listenerCount(signal)).toBe(0);
    }
  });

  it("gives up when the configured wait, counted from the accepted stop, runs out", async () => {
    vi.setSystemTime(T0 + 60_000);
    const state = start({ action: "stop" }, { env: "360000" });
    await vi.advanceTimersByTimeAsync(299_000);
    expect(state.outcome).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(state.outcome).toBe("timeout");
    expect(logger.warn).toHaveBeenLastCalledWith(
      expect.stringContaining("agent-turn wait ran out after 300000ms; stopping with 1 running"),
    );
    expect(getGatewayRestartNotice()).toBeNull();
  });

  it("leaves the cleanup reserve before the shutdown deadline", async () => {
    const state = start({ action: "stop" }, { shutdownDeadline: T0 + 325_000 });
    await vi.advanceTimersByTimeAsync(314_000);
    expect(state.outcome).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(state.outcome).toBe("timeout");
  });

  it("a second stop signal ends the wait at once", async () => {
    const state = start({ action: "stop" });
    await vi.advanceTimersByTimeAsync(60_000);
    signals.emit("SIGINT");
    await vi.advanceTimersByTimeAsync(0);
    expect(state.outcome).toBe("forced");
    expect(logger.warn).toHaveBeenLastCalledWith(
      "received SIGINT while waiting; no longer waiting for running agent turns",
    );
  });

  it("a restart becomes a stop on the first SIGTERM and is forced by the second", async () => {
    const state = start({ action: "restart" });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(getGatewayRestartNotice()?.phase).toBe("draining");
    signals.emit("SIGTERM");
    await vi.advanceTimersByTimeAsync(400_000);
    expect(state.outcome).toBeUndefined();
    expect(getGatewayRestartNotice()?.phase).toBe("stopping");
    signals.emit("SIGTERM");
    await vi.advanceTimersByTimeAsync(0);
    expect(state.outcome).toBe("forced");
    // Turned into a stop: the notice ends with the disconnect instead of "restarting".
    expect(events.at(-1)).toEqual({ notice: null });
  });

  it("SIGQUIT forces a restart wait; the restart notice then says restarting", async () => {
    const state = start({ action: "restart" });
    await vi.advanceTimersByTimeAsync(1_000);
    signals.emit("SIGQUIT");
    await vi.advanceTimersByTimeAsync(0);
    expect(state.outcome).toBe("forced");
    expect(getGatewayRestartNotice()?.phase).toBe("restarting");
    expect(signals.listenerCount("SIGQUIT")).toBe(0);
  });
});
