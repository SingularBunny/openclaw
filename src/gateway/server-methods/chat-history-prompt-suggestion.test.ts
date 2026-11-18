import { afterEach, describe, expect, it } from "vitest";
import {
  emitPromptSuggestion,
  resetPromptSuggestionEventsForTest,
} from "../../infra/prompt-suggestion-events.js";
import { readPromptSuggestionReplay } from "./chat-history-prompt-suggestion.js";

describe("readPromptSuggestionReplay", () => {
  afterEach(() => resetPromptSuggestionEventsForTest());

  it("replays the stored prediction of an idle session, canonical key first", () => {
    emitPromptSuggestion({ sessionKey: "main", text: "alias" });
    emitPromptSuggestion({ sessionKey: "agent:main:main", runId: "run-1", text: "run the tests" });
    expect(readPromptSuggestionReplay(undefined, "agent:main:main", "main")).toEqual({
      promptSuggestion: { sessionKey: "agent:main:main", runId: "run-1", text: "run the tests" },
    });
  });

  it("falls back to the requested key and omits a missing run id", () => {
    emitPromptSuggestion({ sessionKey: "main", text: "check the inbox" });
    expect(readPromptSuggestionReplay(undefined, "agent:main:main", "main")).toEqual({
      promptSuggestion: { sessionKey: "main", text: "check the inbox" },
    });
  });

  it("adds nothing while a run is in flight or nothing is stored", () => {
    emitPromptSuggestion({ sessionKey: "agent:main:main", text: "run the tests" });
    expect(readPromptSuggestionReplay({ runId: "run-2" }, "agent:main:main", "main")).toEqual({});
    expect(readPromptSuggestionReplay(undefined, "agent:other:main", "other")).toEqual({});
  });
});
