import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearPromptSuggestion,
  emitPromptSuggestion,
  getPromptSuggestion,
  onPromptSuggestion,
  resetPromptSuggestionEventsForTest,
} from "./prompt-suggestion-events.js";

afterEach(() => {
  resetPromptSuggestionEventsForTest();
});

describe("prompt suggestion events", () => {
  it("keeps the latest trimmed suggestion per session and notifies listeners", () => {
    const listener = vi.fn();
    const unsubscribe = onPromptSuggestion(listener);
    clearPromptSuggestion("agent:main:main", "run-1");

    expect(
      emitPromptSuggestion({
        sessionKey: "agent:main:main",
        agentId: "main",
        runId: "run-1",
        text: "  run the tests  ",
      }),
    ).toBe(true);
    const expected = {
      sessionKey: "agent:main:main",
      agentId: "main",
      runId: "run-1",
      text: "run the tests",
    };
    expect(listener).toHaveBeenCalledWith(expected);
    expect(getPromptSuggestion("agent:main:main")).toEqual(expected);
    expect(getPromptSuggestion("agent:main:other")).toBeUndefined();

    unsubscribe();
    emitPromptSuggestion({ sessionKey: "agent:main:main", runId: "run-1", text: "commit it" });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getPromptSuggestion("agent:main:main")?.text).toBe("commit it");
  });

  it("clears on a new run and drops a late suggestion from the previous run", () => {
    const listener = vi.fn();
    onPromptSuggestion(listener);
    clearPromptSuggestion("agent:main:main", "run-1");
    emitPromptSuggestion({ sessionKey: "agent:main:main", runId: "run-1", text: "first" });

    clearPromptSuggestion("agent:main:main", "run-2");
    expect(getPromptSuggestion("agent:main:main")).toBeUndefined();
    expect(
      emitPromptSuggestion({ sessionKey: "agent:main:main", runId: "run-1", text: "stale" }),
    ).toBe(false);
    expect(getPromptSuggestion("agent:main:main")).toBeUndefined();

    // A run from another backend clears without claiming the session's CLI run.
    expect(
      emitPromptSuggestion({ sessionKey: "agent:main:main", runId: "run-2", text: "second" }),
    ).toBe(true);
    clearPromptSuggestion("agent:main:main");
    expect(getPromptSuggestion("agent:main:main")).toBeUndefined();
    expect(listener.mock.calls.map(([event]) => event.text)).toEqual(["first", "second"]);
  });

  it("ignores empty and oversized suggestions", () => {
    expect(emitPromptSuggestion({ sessionKey: "agent:main:main", text: "   " })).toBe(false);
    expect(emitPromptSuggestion({ sessionKey: " ", text: "hello" })).toBe(false);
    expect(emitPromptSuggestion({ sessionKey: "agent:main:main", text: "x".repeat(2_001) })).toBe(
      false,
    );
    expect(getPromptSuggestion("agent:main:main")).toBeUndefined();
  });
});
