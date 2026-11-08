import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { validateChatPromptSuggestion } from "../../../../packages/gateway-protocol/src/index.js";
import type { ChatPromptSuggestion } from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import type { GatewayEventFrame } from "../../api/gateway.ts";

/**
 * Claude Code's predicted next prompt for the visible session (`chat.prompt_suggestion`).
 * Presentation only: it becomes a draft only when the operator accepts it with Tab.
 */
export type ChatPromptSuggestionState = {
  sessionKey: string;
  text: string;
  /** A dismissed prediction stays hidden when history replays the same text. */
  dismissed: boolean;
};

export type ChatPromptSuggestionHost = {
  sessionKey: string;
  chatPromptSuggestion?: ChatPromptSuggestionState | null;
  requestUpdate?: () => void;
};

export function readChatPromptSuggestion(payload: unknown): ChatPromptSuggestion | null {
  return validateChatPromptSuggestion(payload) ? payload : null;
}

export function adoptChatPromptSuggestion(host: ChatPromptSuggestionHost, text: string): void {
  const current = host.chatPromptSuggestion;
  if (current?.sessionKey === host.sessionKey && current.text === text) {
    return;
  }
  host.chatPromptSuggestion = { sessionKey: host.sessionKey, text, dismissed: false };
  host.requestUpdate?.();
}

export function dismissChatPromptSuggestion(host: ChatPromptSuggestionHost): void {
  const current = host.chatPromptSuggestion;
  if (!current || current.dismissed) {
    return;
  }
  host.chatPromptSuggestion = { ...current, dismissed: true };
  host.requestUpdate?.();
}

export function clearChatPromptSuggestion(host: ChatPromptSuggestionHost): void {
  if (!host.chatPromptSuggestion) {
    return;
  }
  host.chatPromptSuggestion = null;
  host.requestUpdate?.();
}

export function activeChatPromptSuggestion(host: ChatPromptSuggestionHost): string | null {
  const current = host.chatPromptSuggestion;
  return current && !current.dismissed && current.sessionKey === host.sessionKey
    ? current.text
    : null;
}

/** A prediction arrives after the turn; a new run or another user message retires it. */
export function handleChatPromptSuggestionEvent(
  host: ChatPromptSuggestionHost,
  event: GatewayEventFrame,
  matchesSession: (sessionKey: string, agentId: string | undefined) => boolean,
): void {
  if (event.event === "chat.prompt_suggestion") {
    const suggestion = readChatPromptSuggestion(event.payload);
    if (suggestion && matchesSession(suggestion.sessionKey, undefined)) {
      adoptChatPromptSuggestion(host, suggestion.text);
    }
    return;
  }
  if (event.event !== "chat" && event.event !== "session.message") {
    return;
  }
  const payload = asNullableRecord(event.payload);
  if (
    !host.chatPromptSuggestion ||
    !payload ||
    typeof payload.sessionKey !== "string" ||
    !matchesSession(
      payload.sessionKey,
      typeof payload.agentId === "string" ? payload.agentId : undefined,
    )
  ) {
    return;
  }
  const newRun = event.event === "chat" && payload.state === "delta";
  const userMessage =
    event.event === "session.message" && asNullableRecord(payload.message)?.role === "user";
  if (newRun || userMessage) {
    clearChatPromptSuggestion(host);
  }
}

/** Inserts the accepted prediction as native input so the browser keeps one undo step. */
export function insertChatPromptSuggestion(target: HTMLTextAreaElement, text: string): void {
  target.focus({ preventScroll: true });
  if (!target.ownerDocument.execCommand?.("insertText", false, text)) {
    target.setRangeText(text, 0, target.value.length, "end");
    target.dispatchEvent(
      new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }),
    );
  }
}
