// Fork: Claude CLI subscription limits seen in stream-json (`rate_limit_event`) feed provider usage.
// Kept out of cli-output.ts so upstream changes there merge without conflicts.
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

function parseJsonlRecord(line: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(line);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

type ClaudeRateLimitObservation = {
  status: string;
  limitType?: string;
  resetAt?: number;
};

/**
 * Claude CLI stream-json reports subscription limits per turn as
 * `{"type":"rate_limit_event","rate_limit_info":{"status","rateLimitType","resetsAt"}}`
 * (`resetsAt` in epoch seconds). Returns the normalized observation, or null.
 */
export function parseClaudeRateLimitEvent(line: string): ClaudeRateLimitObservation | null {
  if (!line.includes("rate_limit_event")) {
    return null;
  }
  const parsed = parseJsonlRecord(line);
  if (!parsed || parsed.type !== "rate_limit_event") {
    return null;
  }
  const info = isRecord(parsed.rate_limit_info) ? parsed.rate_limit_info : parsed;
  if (typeof info.status !== "string") {
    return null;
  }
  const resetsAt = typeof info.resetsAt === "number" ? info.resetsAt : undefined;
  return {
    status: info.status,
    ...(typeof info.rateLimitType === "string" ? { limitType: info.rateLimitType } : {}),
    // Seconds per the stream-json contract; tolerate a millisecond value.
    ...(resetsAt !== undefined && Number.isFinite(resetsAt) && resetsAt > 0
      ? { resetAt: resetsAt < 1e12 ? resetsAt * 1000 : resetsAt }
      : {}),
  };
}

export function observeClaudeRateLimitEvent(line: string): void {
  const observation = parseClaudeRateLimitEvent(line);
  if (!observation) {
    return;
  }
  // Loaded on first observation only: the stream parser stays free of usage modules.
  void import("openclaw/plugin-sdk/provider-usage")
    .then(({ recordProviderUsageRateLimit }) =>
      recordProviderUsageRateLimit({ provider: "anthropic", ...observation }),
    )
    .catch(() => {});
}
