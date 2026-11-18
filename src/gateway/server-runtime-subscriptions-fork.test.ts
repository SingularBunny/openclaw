import { afterEach, describe, expect, it, vi } from "vitest";
import { emitAgentEvent, resetAgentEventsForTest } from "../infra/agent-events.js";
import {
  clearPromptSuggestion,
  emitPromptSuggestion,
  getPromptSuggestion,
  resetPromptSuggestionEventsForTest,
} from "../infra/prompt-suggestion-events.js";
import type { GatewayBroadcastFn } from "./server-broadcast-types.js";
import { startForkGatewayEventSubscriptions } from "./server-runtime-subscriptions-fork.js";

describe("startForkGatewayEventSubscriptions", () => {
  afterEach(() => {
    resetPromptSuggestionEventsForTest();
    resetAgentEventsForTest();
  });

  it("broadcasts prompt suggestions to session readers and clears them when a run starts", () => {
    const broadcast = vi.fn() as unknown as GatewayBroadcastFn;
    const unsubscribe = startForkGatewayEventSubscriptions(broadcast);
    clearPromptSuggestion("agent:main:main", "run-suggest");
    emitPromptSuggestion({
      sessionKey: "agent:main:main",
      agentId: "main",
      runId: "run-suggest",
      text: "run the tests",
    });
    emitPromptSuggestion({ sessionKey: "global", agentId: "work", text: "check the inbox" });
    expect(
      vi.mocked(broadcast).mock.calls.filter(([event]) => event === "chat.prompt_suggestion"),
    ).toEqual([
      [
        "chat.prompt_suggestion",
        { sessionKey: "agent:main:main", runId: "run-suggest", text: "run the tests" },
        { sessionKeys: ["agent:main:main"], agentId: "main", dropIfSlow: true },
      ],
      [
        "chat.prompt_suggestion",
        { sessionKey: "global", text: "check the inbox" },
        { sessionKeys: ["agent:work:global", "global"], agentId: "work", dropIfSlow: true },
      ],
    ]);
    expect(getPromptSuggestion("agent:main:main")?.text).toBe("run the tests");

    emitAgentEvent({
      runId: "run-next",
      sessionKey: "agent:main:main",
      stream: "lifecycle",
      data: { phase: "start", startedAt: Date.now() },
    });
    expect(getPromptSuggestion("agent:main:main")).toBeUndefined();
    expect(getPromptSuggestion("global")?.text).toBe("check the inbox");

    unsubscribe();
    vi.mocked(broadcast).mockClear();
    emitPromptSuggestion({ sessionKey: "agent:main:main", text: "after stop" });
    expect(broadcast).not.toHaveBeenCalled();
  });
});
