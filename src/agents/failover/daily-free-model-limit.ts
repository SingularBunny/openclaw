// Fork: a provider's daily free-model quota (OpenRouter `429 ... free-models-per-day`) is not a
// short break; say the daily limit is reached, when it resets if the error says, and what to do.

const DAILY_FREE_MODEL_LIMIT_RE = /\bfree-models-per-day\b/i;
const RATE_LIMIT_RESET_RE = /x-ratelimit-reset\\?["']?\s*[:=]\s*\\?["']?(\d{10,13})\b/i;

/** Copy prefix the Control UI keys on to offer "Choose another model" next to the error. */
export const DAILY_FREE_MODEL_LIMIT_COPY_PREFIX = "⚠️ Daily free-model limit reached";

export function isDailyFreeModelLimitMessage(raw: string | undefined): boolean {
  return typeof raw === "string" && DAILY_FREE_MODEL_LIMIT_RE.test(raw);
}

/** Epoch milliseconds of the quota reset named in the error (`X-RateLimit-Reset`), if any. */
export function extractRateLimitResetMs(raw: string): number | undefined {
  const match = RATE_LIMIT_RESET_RE.exec(raw);
  if (!match?.[1]) {
    return undefined;
  }
  const value = Number(match[1]);
  const ms = match[1].length <= 10 ? value * 1000 : value;
  return Number.isFinite(ms) && ms > 0 ? ms : undefined;
}

function formatResetUtc(ms: number): string {
  // 2026-11-17T00:00:00.000Z -> 2026-11-17 00:00 UTC
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** User copy for a daily free-model quota error, or undefined for any other error. */
export function renderDailyFreeModelLimitCopy(
  raw: string | undefined,
  nowMs = Date.now(),
): string | undefined {
  if (!raw || !isDailyFreeModelLimitMessage(raw)) {
    return undefined;
  }
  const resetMs = extractRateLimitResetMs(raw);
  const reset =
    resetMs !== undefined && resetMs > nowMs
      ? ` It resets at ${formatResetUtc(resetMs)}.`
      : " It resets once a day.";
  return `${DAILY_FREE_MODEL_LIMIT_COPY_PREFIX} for this provider.${reset} Choose another model to continue now.`;
}
