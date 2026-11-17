// Fork: an ACP turn fires agent_end, so plugins can wait for an ACP agent's reply.
import { beforeEach, describe, expect, it, vi } from "vitest";

const runner = vi.hoisted(() => ({
  hasHooks: vi.fn((_name: string) => true),
  runAgentEnd: vi.fn(async (_event: unknown, _ctx: unknown, _options?: unknown) => undefined),
}));
vi.mock("../../plugins/hook-runner-global.js", () => ({ getGlobalHookRunner: () => runner }));

import { buildAcpTurnAgentEndMessages, runAcpTurnAgentEndHook } from "./acp-agent-end.js";

const TARGET = {
  runId: "run-7",
  agentId: "main",
  sessionKey: "agent:main:acp:7f3c",
  sessionId: "sid-7",
  acpAgent: "junie",
  promptText: "Review the patch",
};

async function settle() {
  await vi.waitFor(() => expect(runner.runAgentEnd).toHaveBeenCalled());
  return runner.runAgentEnd.mock.calls[0] as [Record<string, unknown>, Record<string, unknown>];
}

describe("ACP turn agent_end hook", () => {
  beforeEach(() => {
    runner.runAgentEnd.mockClear();
    runner.hasHooks.mockReturnValue(true);
  });

  it("reports a finished ACP reply with its agent as provider acp", async () => {
    runAcpTurnAgentEndHook({ ...TARGET, finalText: "Looks good.", success: true, startedAt: 1 });
    const [event, ctx] = await settle();
    expect(event).toMatchObject({ runId: "run-7", success: true });
    expect(event.durationMs).toBeGreaterThanOrEqual(0);
    expect(event.messages).toEqual([
      expect.objectContaining({
        role: "user",
        content: [{ type: "text", text: "Review the patch" }],
      }),
      expect.objectContaining({
        role: "assistant",
        content: [{ type: "text", text: "Looks good." }],
        provider: "acp",
        model: "junie",
        stopReason: "stop",
      }),
    ]);
    expect(ctx).toEqual({
      runId: "run-7",
      agentId: "main",
      sessionKey: "agent:main:acp:7f3c",
      sessionId: "sid-7",
      modelProviderId: "acp",
      modelId: "junie",
    });
  });

  it("reports a failed turn with its error and any partial reply", async () => {
    runAcpTurnAgentEndHook({ ...TARGET, finalText: "", success: false, error: "ACP_TURN_FAILED" });
    const [event] = await settle();
    expect(event).toMatchObject({ success: false, error: "ACP_TURN_FAILED" });
    expect(event.messages).toHaveLength(1);
    expect(
      buildAcpTurnAgentEndMessages({ ...TARGET, finalText: "half", success: false, error: "x" }),
    ).toEqual([
      expect.objectContaining({ role: "user" }),
      expect.objectContaining({ role: "assistant", stopReason: "error", errorMessage: "x" }),
    ]);
  });

  it("does nothing without agent_end subscribers", async () => {
    runner.hasHooks.mockReturnValue(false);
    runAcpTurnAgentEndHook({ ...TARGET, finalText: "ok", success: true });
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
    expect(runner.runAgentEnd).not.toHaveBeenCalled();
  });
});
