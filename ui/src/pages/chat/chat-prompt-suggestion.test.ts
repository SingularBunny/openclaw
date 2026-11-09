/* @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayEventFrame } from "../../api/gateway.ts";
import { renderComposerFixture, resetComposerFixture } from "./chat-composer.test-support.ts";
import {
  activeChatPromptSuggestion,
  adoptChatPromptSuggestion,
  dismissChatPromptSuggestion,
  handleChatPromptSuggestionEvent,
  type ChatPromptSuggestionHost,
} from "./chat-prompt-suggestion.ts";

afterEach(() => resetComposerFixture());

function frame(event: string, payload: unknown): GatewayEventFrame {
  return { type: "event", event, payload };
}

function createHost(sessionKey = "agent:main:main"): ChatPromptSuggestionHost {
  return { sessionKey, chatPromptSuggestion: null, requestUpdate: vi.fn() };
}

const sameSession = (host: ChatPromptSuggestionHost) => (sessionKey: string) =>
  sessionKey === host.sessionKey;

function getTextarea(container: HTMLElement): HTMLTextAreaElement {
  const textarea = container.querySelector("textarea");
  if (!textarea) {
    throw new Error("Expected composer textarea");
  }
  return textarea;
}

function ghostText(container: HTMLElement): string | null {
  const ghost = container.querySelector(".agent-chat__composer-placeholder--suggestion");
  return ghost ? (ghost.textContent ?? "").trim() : null;
}

function keydown(target: HTMLTextAreaElement, key: string) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

describe("chat prompt suggestion state", () => {
  it("adopts a validated suggestion for the visible session only", () => {
    const host = createHost();
    handleChatPromptSuggestionEvent(
      host,
      frame("chat.prompt_suggestion", { sessionKey: "agent:main:other", text: "elsewhere" }),
      sameSession(host),
    );
    handleChatPromptSuggestionEvent(
      host,
      frame("chat.prompt_suggestion", { sessionKey: "agent:main:main", text: "" }),
      sameSession(host),
    );
    expect(activeChatPromptSuggestion(host)).toBeNull();

    handleChatPromptSuggestionEvent(
      host,
      frame("chat.prompt_suggestion", {
        sessionKey: "agent:main:main",
        runId: "run-1",
        text: "run the tests",
      }),
      sameSession(host),
    );
    expect(activeChatPromptSuggestion(host)).toBe("run the tests");
    expect(host.requestUpdate).toHaveBeenCalledOnce();

    host.sessionKey = "agent:main:other";
    expect(activeChatPromptSuggestion(host)).toBeNull();
  });

  it("clears on a new run or another user message and keeps a dismissal across replays", () => {
    const host = createHost();
    adoptChatPromptSuggestion(host, "run the tests");
    handleChatPromptSuggestionEvent(
      host,
      frame("chat", { sessionKey: "agent:main:main", runId: "run-1", state: "final" }),
      sameSession(host),
    );
    expect(activeChatPromptSuggestion(host)).toBe("run the tests");
    handleChatPromptSuggestionEvent(
      host,
      frame("chat", { sessionKey: "agent:main:main", runId: "run-2", state: "delta" }),
      sameSession(host),
    );
    expect(host.chatPromptSuggestion).toBeNull();

    adoptChatPromptSuggestion(host, "commit it");
    handleChatPromptSuggestionEvent(
      host,
      frame("session.message", { sessionKey: "agent:main:main", message: { role: "user" } }),
      sameSession(host),
    );
    expect(host.chatPromptSuggestion).toBeNull();

    adoptChatPromptSuggestion(host, "open a PR");
    dismissChatPromptSuggestion(host);
    adoptChatPromptSuggestion(host, "open a PR");
    expect(activeChatPromptSuggestion(host)).toBeNull();
    adoptChatPromptSuggestion(host, "something new");
    expect(activeChatPromptSuggestion(host)).toBe("something new");
  });
});

describe("chat composer prompt suggestion", () => {
  it("shows ghost text in the empty idle composer and accepts it with Tab", () => {
    const onDismissPromptSuggestion = vi.fn();
    const onDraftChange = vi.fn();
    const { container } = renderComposerFixture({
      promptSuggestion: "run the tests",
      onDismissPromptSuggestion,
      onDraftChange,
    });
    const textarea = getTextarea(container);
    expect(ghostText(container)).toBe("run the tests");
    expect(textarea.placeholder).toBe("run the tests");

    const event = keydown(textarea, "Tab");
    expect(event.defaultPrevented).toBe(true);
    expect(textarea.value).toBe("run the tests");
    expect(onDraftChange).toHaveBeenLastCalledWith("run the tests", undefined);
    expect(onDismissPromptSuggestion).toHaveBeenCalled();
  });

  it("dismisses with Escape, only hides while typing, and leaves Tab alone without a suggestion", () => {
    const onDismissPromptSuggestion = vi.fn();
    const escaped = renderComposerFixture({
      promptSuggestion: "run the tests",
      onDismissPromptSuggestion,
    });
    const escapeEvent = keydown(getTextarea(escaped.container), "Escape");
    expect(escapeEvent.defaultPrevented).toBe(true);
    expect(onDismissPromptSuggestion).toHaveBeenCalledOnce();

    const onTypingDismiss = vi.fn();
    const typed = renderComposerFixture({
      promptSuggestion: "run the tests",
      onDismissPromptSuggestion: onTypingDismiss,
    });
    const textarea = getTextarea(typed.container);
    textarea.value = "h";
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
    // Typing hides the ghost text through the draft; clearing it brings the suggestion back (Claude Code).
    expect(onTypingDismiss).not.toHaveBeenCalled();

    const plain = renderComposerFixture({});
    const tab = keydown(getTextarea(plain.container), "Tab");
    expect(tab.defaultPrevented).toBe(false);
    expect(ghostText(plain.container)).toBeNull();
  });

  it("hides the suggestion while a run is working or a draft exists", () => {
    const busy = renderComposerFixture({
      promptSuggestion: "run the tests",
      sending: true,
    });
    expect(ghostText(busy.container)).toBeNull();
    const drafted = renderComposerFixture({ promptSuggestion: "run the tests", draft: "hello" });
    expect(ghostText(drafted.container)).toBeNull();
    const event = keydown(getTextarea(drafted.container), "Tab");
    expect(event.defaultPrevented).toBe(false);
  });
});
