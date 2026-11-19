// Fork (F89): Claude CLI retries a failed or unanswered model request on its own and says so
// (`system/api_retry`: attempt, max_retries, retry_delay_ms, error_status, error). The chat used
// to show only "Waiting for a response" meanwhile. Each retry is published as the shared
// `run_status` `retrying` event the embedded runner uses for rate limits, with the attempt and
// the error, so the chat names what OpenClaw waits for.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { emitAgentEvent } from "../../infra/agent-events.js";

/** The chat protocol's retry reasons (`ChatStatusEvent.retry.reason`). */
export type CliModelRetryReason = "rate_limit" | "overloaded" | "server_error" | "timeout";

/** The chat protocol bounds attempts to 1-10; Claude CLI retries up to 10 times by default. */
const MAX_REPORTED_ATTEMPT = 10;

function retryReason(errorStatus: number | undefined, noResponse: boolean): CliModelRetryReason {
  if (noResponse || errorStatus === 408 || errorStatus === 504) {
    return "timeout";
  }
  if (errorStatus === 429) {
    return "rate_limit";
  }
  return errorStatus === 529 ? "overloaded" : "server_error";
}

export type CliModelRetryStatus = {
  phase: "retrying";
  reason: CliModelRetryReason;
  message: string;
  attempt?: number;
  maxAttempts?: number;
  errorStatus?: number;
  error?: string;
  noResponse?: true;
  delayMs?: number;
  retryAt?: number;
};

const positiveInt = (value: unknown) =>
  typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
const nonNegative = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

/** The status for one `api_retry` record; undefined for any other record. */
export function cliModelRetryStatus(
  record: Record<string, unknown>,
  now = Date.now(),
): CliModelRetryStatus | undefined {
  if (record.type !== "system" || record.subtype !== "api_retry") {
    return undefined;
  }
  const attempt = positiveInt(record.attempt);
  const maxAttempts = positiveInt(record.max_retries);
  const errorStatus = positiveInt(record.error_status);
  const error =
    typeof record.error === "string" && record.error.trim() && record.error !== "unknown"
      ? record.error.trim().slice(0, 80)
      : undefined;
  const noResponse = isRecord(record.no_response) ? record.no_response : undefined;
  const waitedMs = nonNegative(noResponse?.waited_ms);
  const delayMs = nonNegative(record.retry_delay_ms);
  const cause = noResponse
    ? `No response from the model${waitedMs === undefined ? "" : ` for ${Math.round(waitedMs / 1000)}s`}`
    : `Model request failed${
        errorStatus || error ? ` (${[errorStatus, error].filter(Boolean).join(" ")})` : ""
      }`;
  const count = attempt
    ? ` Retry ${attempt}${maxAttempts ? ` of ${maxAttempts}` : ""}`
    : " Retrying";
  const when = delayMs ? ` in ${Math.ceil(delayMs / 1000)}s.` : ".";
  return {
    phase: "retrying",
    reason: retryReason(errorStatus, Boolean(noResponse)),
    message: `${cause}.${count}${when}`,
    ...(attempt ? { attempt: Math.min(attempt, MAX_REPORTED_ATTEMPT) } : {}),
    ...(maxAttempts ? { maxAttempts: Math.min(maxAttempts, MAX_REPORTED_ATTEMPT) } : {}),
    ...(errorStatus ? { errorStatus } : {}),
    ...(error ? { error } : {}),
    ...(noResponse ? { noResponse: true as const } : {}),
    ...(delayMs === undefined ? {} : { delayMs, retryAt: now + delayMs }),
  };
}

/** Publishes each Claude CLI model retry of a visible turn to the chat. */
export function createCliModelRetryStatusObserver(run: {
  runId: string;
  sessionKey?: string;
  executionMode?: string;
}) {
  const visible = run.executionMode !== "side-question";
  return {
    observe(record: Record<string, unknown>) {
      const status = visible ? cliModelRetryStatus(record) : undefined;
      if (status) {
        emitAgentEvent({
          runId: run.runId,
          ...(run.sessionKey ? { sessionKey: run.sessionKey } : {}),
          stream: "run_status",
          data: status,
        });
      }
    },
  };
}
