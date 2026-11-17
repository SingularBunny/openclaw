import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEventOutcome } from "../auto-reply/reply/session-event-contract.js";
import { makeCronJob } from "./delivery.test-helpers.js";
import { resolveCronSourceDeliveryPlan } from "./isolated-agent/source-delivery-plan.js";
import {
  markAutomationRunUnread,
  shouldMarkAutomationRunUnread,
} from "./session-run-unread-mark.js";
import { runCronSessionTurn } from "./session-run.js";

const fixture = vi.hoisted(() => ({
  apply: vi.fn(async () => null),
  capture: vi.fn(),
  enqueue: vi.fn(),
  delivery: vi.fn(),
}));

// mock-isolation: The storage owner is observed, not exercised.
vi.mock("../config/sessions/session-accessor.sqlite-entry.js", () => ({
  applySessionEntryOperation: fixture.apply,
}));
// mock-isolation: Fixed session receipts exercise the Cron owner without invoking a model.
vi.mock("../auto-reply/reply/session-event-handoff.js", () => ({
  captureSessionEventTargetForHost: fixture.capture,
  enqueueSessionEventForHost: fixture.enqueue,
}));
// mock-isolation: The fixture supplies current configuration independently of process state.
vi.mock("../config/config.js", () => ({ getRuntimeConfig: () => ({}) }));
// mock-isolation: The fixed route avoids loading external channel runtimes.
vi.mock("./isolated-agent/run-delivery-trace.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./isolated-agent/run-delivery-trace.js")>()),
  resolveCronDeliveryContext: fixture.delivery,
}));

beforeEach(() => {
  vi.resetAllMocks();
  fixture.apply.mockResolvedValue(null);
  fixture.capture.mockResolvedValue({
    agentId: "main",
    sessionId: "target-session",
    sessionKey: "agent:main:scheduled",
    storePath: "/state/main",
    generation: "g",
  });
  const deliveryPlan = { mode: "none" as const, source: "delivery" as const, requested: false };
  const resolvedDelivery = { ok: false as const, mode: "implicit" as const, error: new Error("x") };
  fixture.delivery.mockResolvedValue({
    deliveryPlan,
    deliveryRequested: false,
    resolvedDelivery,
    sourceDelivery: resolveCronSourceDeliveryPlan({ deliveryPlan, resolvedDelivery }),
  });
});

function settle(outcome: Partial<SessionEventOutcome>) {
  fixture.enqueue.mockReturnValue({
    id: "event",
    cancel: () => false,
    accepted: Promise.resolve({ ok: true }),
    settled: Promise.resolve({ executionStarted: true, delivered: false, ...outcome }),
  });
}

async function run() {
  await runCronSessionTurn({
    cfg: {},
    agentId: "main",
    sessionKey: "agent:main:scheduled",
    admissionSource: "requester-schedule",
    deliveryAttemptFence: null,
    text: "Check the queue.",
    job: makeCronJob({ sessionTarget: "session:agent:main:scheduled", delivery: { mode: "none" } }),
    assertCurrent: () => {},
  } as Parameters<typeof runCronSessionTurn>[0]);
}

describe("automation unread mark", () => {
  it.each([
    [{ status: "completed", executionStarted: true, replyDisposition: "silent" }, true],
    [{ status: "completed", executionStarted: true, replyDisposition: "empty" }, true],
    [{ status: "completed", executionStarted: true }, true],
    [{ status: "failed", executionStarted: true, replyDisposition: "visible" }, true],
    [{ status: "completed", executionStarted: true, replyDisposition: "visible" }, false],
    [{ status: "cancelled", executionStarted: true, replyDisposition: "silent" }, false],
    [{ status: "failed", executionStarted: false }, false],
  ] as const)("decides %j -> %s", (facts, expected) => {
    expect(shouldMarkAutomationRunUnread(facts)).toBe(expected);
  });

  it("marks the chat unread after a silent scheduled turn", async () => {
    settle({ status: "completed", automationResult: { replyDisposition: "silent" } });
    await run();
    expect(fixture.apply).toHaveBeenCalledTimes(1);
    expect(fixture.apply).toHaveBeenCalledWith(
      { agentId: "main", sessionKey: "agent:main:scheduled", storePath: "/state/main" },
      {
        kind: "fields",
        patch: { markedUnreadAt: expect.any(Number) },
        expected: { sessionId: "target-session" },
      },
      { preserveActivity: true },
    );
  });

  it("leaves a visible scheduled turn to the ordinary unread flow", async () => {
    settle({ status: "completed", automationResult: { replyDisposition: "visible" } });
    await run();
    expect(fixture.apply).not.toHaveBeenCalled();
  });

  it("does not fail the run when the mark cannot be written", async () => {
    fixture.apply.mockRejectedValue(new Error("busy"));
    await expect(
      markAutomationRunUnread({ agentId: "main", sessionKey: "agent:main:a", now: 5 }),
    ).resolves.toBeUndefined();
  });
});
