import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getGatewayRestartNotice,
  resetGatewayRestartNoticeForTest,
  setGatewayRestartNoticeBroadcaster,
  trackGatewayRestartDeferral,
  type GatewayRestartNoticeEventPayload,
} from "./restart-notice.js";

describe("gateway restart notice", () => {
  let events: GatewayRestartNoticeEventPayload[];
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    resetGatewayRestartNoticeForTest();
    events = [];
    setGatewayRestartNoticeBroadcaster((payload) => events.push(payload));
  });
  afterEach(() => {
    resetGatewayRestartNoticeForTest();
    vi.useRealTimers();
  });

  it("publishes a pending restart, follows the waiting counts and clears it", () => {
    const counts = { agentTurns: 2, totalActive: 3 };
    const handle = trackGatewayRestartDeferral({
      reason: "config reload: env.vars.X",
      budgetMs: 300_000,
      agentRunWaitMs: 1_800_000,
      getCounts: () => counts,
      pollMs: 1_000,
    });
    const pending = {
      phase: "pending",
      reason: "config reload: env.vars.X",
      since: 1_000_000,
      deadlineAt: 1_000_000 + 1_800_000,
      activeTurns: 2,
      activeWork: 3,
    };
    expect(events).toEqual([{ notice: pending }]);
    expect(getGatewayRestartNotice()).toEqual(pending);

    // Unchanged counts publish nothing; a finished turn is published.
    vi.advanceTimersByTime(3_000);
    expect(events).toHaveLength(1);
    counts.agentTurns = 1;
    counts.totalActive = 1;
    vi.advanceTimersByTime(1_000);
    expect(events.at(-1)).toEqual({ notice: { ...pending, activeTurns: 1, activeWork: 1 } });

    handle.clear();
    expect(events.at(-1)).toEqual({ notice: null });
    expect(getGatewayRestartNotice()).toBeNull();
    vi.advanceTimersByTime(10_000);
    expect(events.at(-1)).toEqual({ notice: null });
  });

  it("uses upstream's budget as the deadline, or none for an unlimited wait", () => {
    trackGatewayRestartDeferral({
      reason: "r",
      budgetMs: 300_000,
      getCounts: () => ({ agentTurns: 0, totalActive: 1 }),
    });
    expect(getGatewayRestartNotice()?.deadlineAt).toBe(1_300_000);
    trackGatewayRestartDeferral({
      reason: "r",
      budgetMs: 300_000,
      agentRunWaitMs: null,
      getCounts: () => ({ agentTurns: 1, totalActive: 1 }),
    });
    expect(getGatewayRestartNotice()?.deadlineAt).toBeNull();
  });

  it("marks the restart as happening now, and drops a restart that never came", () => {
    const handle = trackGatewayRestartDeferral({
      reason: "r",
      budgetMs: 300_000,
      getCounts: () => ({ agentTurns: 0, totalActive: 0 }),
    });
    handle.restarting();
    expect(getGatewayRestartNotice()?.phase).toBe("restarting");
    vi.advanceTimersByTime(120_000);
    expect(getGatewayRestartNotice()).toBeNull();
  });

  it("a superseded request cannot clear its replacement", () => {
    const first = trackGatewayRestartDeferral({
      reason: "first",
      budgetMs: 300_000,
      getCounts: () => ({ agentTurns: 1, totalActive: 1 }),
    });
    trackGatewayRestartDeferral({
      reason: "second",
      budgetMs: 300_000,
      getCounts: () => ({ agentTurns: 1, totalActive: 1 }),
    });
    first.clear();
    first.restarting();
    expect(getGatewayRestartNotice()).toMatchObject({ phase: "pending", reason: "second" });
  });

  it("keeps the last counts when reading them fails, and survives a failing broadcaster", () => {
    setGatewayRestartNoticeBroadcaster(() => {
      throw new Error("socket gone");
    });
    let fail = false;
    trackGatewayRestartDeferral({
      reason: "r",
      budgetMs: 300_000,
      getCounts: () => {
        if (fail) {
          throw new Error("unknown");
        }
        return { agentTurns: 1, totalActive: 2 };
      },
      pollMs: 1_000,
    });
    fail = true;
    vi.advanceTimersByTime(1_000);
    expect(getGatewayRestartNotice()).toMatchObject({ activeTurns: 1, activeWork: 2 });
  });
});
