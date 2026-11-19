// Fork: a chat or automation that failed because Claude Code's own subscription login expired
// gets one dedicated Web Push, so morning automations do not fail silently until someone looks.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { WebPushNotificationCategory } from "../../packages/gateway-protocol/src/schema/push.js";

// Same phrases as ui/src/lib/chat/claude-cli-login.ts; never a provider name alone.
const CLAUDE_CLI_LOGIN_EXPIRED_PATTERNS: readonly RegExp[] = [
  /\bClaude subscription login expired\b/i,
  /\bOAuth session expired and could not be refreshed\b/i,
  /\bNot logged in\s*·\s*Please run \/login\b/i,
  /\bclaude-cli\b[\s\S]+?\b(?:failed to authenticate|401\s+invalid authentication credentials)\b/i,
];

/** One tag for the whole Gateway: repeated failures replace the shown notification. */
export const CLAUDE_LOGIN_EXPIRED_PUSH_TAG = "openclaw-claude-login-expired";
/** Every failing automation reports the same login; resend at most this often. */
export const CLAUDE_LOGIN_EXPIRED_PUSH_INTERVAL_MS = 30 * 60_000;

export type ClaudeLoginExpiredNotification = {
  category: WebPushNotificationCategory;
  title: string;
  body: string;
  tag: string;
  path?: string;
};

export function isClaudeCliLoginExpiredText(text: string | undefined): boolean {
  return text ? CLAUDE_CLI_LOGIN_EXPIRED_PATTERNS.some((pattern) => pattern.test(text)) : false;
}

/** A reply is a login failure only when it opens with it; quoting the phrase is not. */
function isClaudeCliLoginExpiredReply(text: string | undefined): boolean {
  const opening = text?.replace(/^(?:\s|\u26A0\uFE0F?)+/u, "").slice(0, 200);
  return opening
    ? CLAUDE_CLI_LOGIN_EXPIRED_PATTERNS.some((pattern) => opening.search(pattern) === 0)
    : false;
}

function messageText(message: unknown): string | undefined {
  if (typeof message === "string") {
    return message;
  }
  if (!isRecord(message)) {
    return undefined;
  }
  if (typeof message.text === "string") {
    return message.text;
  }
  if (!Array.isArray(message.content)) {
    return typeof message.content === "string" ? message.content : undefined;
  }
  return message.content
    .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
    .join("\n");
}

function isLoginExpiredFailure(event: string, value: Record<string, unknown>): boolean {
  if (event === "chat" && value.state === "error") {
    return isClaudeCliLoginExpiredText(
      typeof value.errorMessage === "string" ? value.errorMessage : undefined,
    );
  }
  if (event === "chat" && value.state === "final") {
    return isClaudeCliLoginExpiredReply(messageText(value.message));
  }
  if (event === "cron" && value.action === "finished" && value.status === "error") {
    // Only the run error: the summary is the agent's own text and may quote the phrase.
    return isClaudeCliLoginExpiredText(typeof value.error === "string" ? value.error : undefined);
  }
  return false;
}

/** Classifies a login-expired failure; the caller applies the send interval. */
export function resolveClaudeLoginExpiredWebPush(
  event: string,
  payload: unknown,
): ClaudeLoginExpiredNotification | null {
  if (!isRecord(payload) || !isLoginExpiredFailure(event, payload)) {
    return null;
  }
  return {
    category: event === "cron" ? "scheduled-task-failed" : "agent-finished",
    title: "Claude login expired",
    body: "Chats and automations on Claude CLI stop until you run claude auth login on the Gateway host.",
    tag: CLAUDE_LOGIN_EXPIRED_PUSH_TAG,
    ...(event === "cron" ? { path: "automations" } : {}),
  };
}

/** Lets the first login-expired push through, then one per interval. */
export function createClaudeLoginExpiredPushGate(now: () => number = Date.now) {
  let lastSentAt: number | undefined;
  return (): boolean => {
    const at = now();
    if (lastSentAt !== undefined && at - lastSentAt < CLAUDE_LOGIN_EXPIRED_PUSH_INTERVAL_MS) {
      return false;
    }
    lastSentAt = at;
    return true;
  };
}
