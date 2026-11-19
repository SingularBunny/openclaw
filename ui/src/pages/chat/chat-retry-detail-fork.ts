// Fork (F89): what a retrying turn waits for — the attempt and the reason the model request
// failed — next to "Retrying…". The Gateway sends them in `ChatStatusEvent.retry` and in the
// `run_status` agent event (Claude CLI's own retries included); before, the chat showed only
// "Retrying…" or "Waiting for a response".
import { registerModelControlsEnglish } from "../../i18n/locales/en-model-controls.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";

registerEnglishCatalog(registerModelControlsEnglish);

const REASON_KEYS = {
  rate_limit: "chat.retryDetail.reason.rate_limit",
  overloaded: "chat.retryDetail.reason.overloaded",
  server_error: "chat.retryDetail.reason.server_error",
  timeout: "chat.retryDetail.reason.timeout",
  output_limit: "chat.retryDetail.reason.output_limit",
} as const;
type ChatRetryReason = keyof typeof REASON_KEYS;
const REASONS = Object.keys(REASON_KEYS) as ChatRetryReason[];

export type ChatRetryDetail = { attempt?: number; maxAttempts?: number; reason?: ChatRetryReason };

const count = (value: unknown) =>
  typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;

/** The attempt and reason of a retry status, if it carries any. */
export function readChatRetryDetail(source: unknown): ChatRetryDetail | undefined {
  if (!source || typeof source !== "object") {
    return undefined;
  }
  const record = source as Record<string, unknown>;
  const attempt = count(record.attempt);
  const maxAttempts = count(record.maxAttempts);
  const reason = REASONS.find((candidate) => candidate === record.reason);
  return attempt || reason
    ? {
        ...(attempt ? { attempt } : {}),
        ...(attempt && maxAttempts ? { maxAttempts } : {}),
        ...(reason ? { reason } : {}),
      }
    : undefined;
}

/** `{ detail }` for a retrying startup status, or nothing. */
export function withChatRetryDetail(source: unknown): { detail?: ChatRetryDetail } {
  const detail = readChatRetryDetail(source);
  return detail ? { detail } : {};
}

/** "attempt 3 of 10 · model overloaded", or undefined when nothing is known. */
export function chatRetryDetailLabel(detail: ChatRetryDetail | undefined): string | undefined {
  if (!detail) {
    return undefined;
  }
  const parts: string[] = [];
  if (detail.attempt) {
    parts.push(
      detail.maxAttempts
        ? t("chat.retryDetail.attemptOf", {
            attempt: String(detail.attempt),
            max: String(detail.maxAttempts),
          })
        : t("chat.retryDetail.attempt", { attempt: String(detail.attempt) }),
    );
  }
  if (detail.reason) {
    parts.push(t(REASON_KEYS[detail.reason]));
  }
  return parts.length > 0 ? parts.join(" · ") : undefined;
}
