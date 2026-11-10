import { expect, it } from "vitest";
import { BLOCKED_TOOL_CALL_ABORT_FLOOR_MS } from "../../logging/diagnostic-run-activity.js";
import { resolveCliNoOutputTimeoutDecision } from "./no-output-timeout-policy.js";

it("never shortens a configured no-output budget longer than the outstanding-work floor", () => {
  const decision = resolveCliNoOutputTimeoutDecision({
    context: {
      provider: "claude-cli",
      model: "claude-sonnet-4-6",
      sessionId: "s1",
      lane: undefined,
    },
    timeoutMs: BLOCKED_TOOL_CALL_ABORT_FLOOR_MS * 2,
    quietDurationMs: BLOCKED_TOOL_CALL_ABORT_FLOOR_MS,
    cliTimeout: {
      mode: "no-output",
      timeoutSeconds: BLOCKED_TOOL_CALL_ABORT_FLOOR_MS / 1000,
      observedActivity: true,
      activeToolCount: 0,
      backgroundTaskCount: 0,
      compactionActive: true,
    },
    hasOutputText: false,
    useResume: false,
    hasReplayUnsafeActivity: true,
    outstandingWorkGraceMs: BLOCKED_TOOL_CALL_ABORT_FLOOR_MS,
  });
  expect(decision.deferMs).toBe(BLOCKED_TOOL_CALL_ABORT_FLOOR_MS);
});

it("defers to a pending model request without counting it as tool work", () => {
  const decision = resolveCliNoOutputTimeoutDecision({
    context: { provider: "claude-cli", model: "claude-opus-5-5", sessionId: "s1", lane: undefined },
    timeoutMs: 180_000,
    quietDurationMs: 180_000,
    cliTimeout: {
      mode: "no-output",
      timeoutSeconds: 180,
      observedActivity: true,
      activeToolCount: 0,
      backgroundTaskCount: 0,
      awaitingModelResponse: true,
    },
    hasOutputText: false,
    useResume: true,
    hasReplayUnsafeActivity: true,
    outstandingWorkGraceMs: BLOCKED_TOOL_CALL_ABORT_FLOOR_MS,
    modelRequestGraceMs: 210_000,
  });
  expect(decision.deferMs).toBe(30_000);
});
