import { describe, expect, it, vi } from "vitest";
import { makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
import { loadRunCronIsolatedAgentTurn, runWithModelFallbackMock } from "./run.test-harness.js";

const mark = vi.hoisted(() => vi.fn(async () => {}));
// mock-isolation: The unread decision and storage write have their own contract tests.
vi.mock("../session-run-unread-mark.js", () => ({ markIsolatedCronRunUnread: mark }));
// mock-isolation: Keep the database-backed descendant registry outside the fixture.
vi.mock("./delivery-subagent-registry.runtime.js", () => ({
  hasUnsettledCronDescendants: async () => false,
}));

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

function mockAgentRun(meta: Record<string, unknown>, payloads: unknown[] = []) {
  runWithModelFallbackMock.mockResolvedValueOnce({
    result: {
      result: { payloads, meta: { agentMeta: { usage: { input: 10, output: 1 } }, ...meta } },
    },
    provider: "anthropic",
    model: "claude-opus-4-8",
    attempts: [],
  });
}

describe("runCronIsolatedAgentTurn - unread mark for silent runs", () => {
  setupRunCronIsolatedAgentTurnSuite();

  it("reports a silent isolated run against the cron chat row", async () => {
    mark.mockClear();
    mockAgentRun({ terminalReply: { disposition: "silent", text: "NO_REPLY" } });
    const params = makeIsolatedAgentParamsFixture();
    await runCronIsolatedAgentTurn(params);
    expect(mark).toHaveBeenCalledTimes(1);
    expect(mark).toHaveBeenCalledWith(
      expect.objectContaining({ status: "ok", aborted: false, replyDisposition: "silent" }),
    );
    const call = (mark.mock.calls[0] as unknown[] | undefined)?.[0] as { sessionKey: string };
    expect(call.sessionKey).not.toContain(":run:");
  });

  it("reports a visible isolated run as visible", async () => {
    mark.mockClear();
    mockAgentRun({ terminalReply: { disposition: "visible", text: "Daily report" } }, [
      { text: "Daily report" },
    ]);
    await runCronIsolatedAgentTurn(makeIsolatedAgentParamsFixture());
    expect(mark).toHaveBeenCalledWith(
      expect.objectContaining({ status: "ok", replyDisposition: "visible" }),
    );
  });
});
