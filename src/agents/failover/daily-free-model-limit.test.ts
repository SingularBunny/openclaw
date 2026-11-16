import { describe, expect, it } from "vitest";
import { formatAssistantErrorText } from "../embedded-agent-helpers/error-text.js";
import { renderRecordedAssistantFailureCopy } from "./assistant-request-failure-copy.js";
import {
  DAILY_FREE_MODEL_LIMIT_COPY_PREFIX,
  extractRateLimitResetMs,
  renderDailyFreeModelLimitCopy,
} from "./daily-free-model-limit.js";
import { renderRateLimitReplyCopy } from "./user-copy.js";

const NOW = Date.parse("2026-11-16T09:00:00.000Z");
const RESET = Date.parse("2026-11-17T00:00:00.000Z");
const OPENROUTER_ERROR = `429 {"error":{"message":"Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day","code":429,"metadata":{"headers":{"X-RateLimit-Limit":"50","X-RateLimit-Remaining":"0","X-RateLimit-Reset":"${RESET}"},"provider_name":null}}}`;

describe("daily free-model limit copy", () => {
  it("names the daily limit and its reset time", () => {
    expect(extractRateLimitResetMs(OPENROUTER_ERROR)).toBe(RESET);
    expect(extractRateLimitResetMs('\\"X-RateLimit-Reset\\":\\"1763337600\\"')).toBe(
      1763337600_000,
    );
    expect(renderDailyFreeModelLimitCopy(OPENROUTER_ERROR, NOW)).toBe(
      "⚠️ Daily free-model limit reached for this provider. It resets at 2026-11-17 00:00 UTC. Choose another model to continue now.",
    );
    expect(
      renderDailyFreeModelLimitCopy(
        "429 Rate limit exceeded: free-models-per-day-high-balance.",
        NOW,
      ),
    ).toBe(
      "⚠️ Daily free-model limit reached for this provider. It resets once a day. Choose another model to continue now.",
    );
  });

  it("leaves other rate limits alone", () => {
    expect(renderDailyFreeModelLimitCopy("429 Too many requests", NOW)).toBeUndefined();
    expect(renderDailyFreeModelLimitCopy(undefined, NOW)).toBeUndefined();
  });

  it("replaces the short-break copy in replies, recorded rows and live error text", () => {
    expect(
      renderRateLimitReplyCopy({ message: OPENROUTER_ERROR, reason: "rate_limit", nowMs: NOW }),
    ).toContain(DAILY_FREE_MODEL_LIMIT_COPY_PREFIX);
    expect(
      renderRateLimitReplyCopy({
        message: "All models failed",
        reason: "rate_limit",
        attempts: [
          {
            provider: "openrouter",
            model: "x/y:free",
            reason: "rate_limit",
            error: OPENROUTER_ERROR,
          },
        ],
        nowMs: NOW,
      }),
    ).toContain(DAILY_FREE_MODEL_LIMIT_COPY_PREFIX);
    expect(renderRecordedAssistantFailureCopy({ errorMessage: OPENROUTER_ERROR })).toMatch(
      /^⚠️ Daily free-model limit reached/u,
    );
    expect(
      formatAssistantErrorText({
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: OPENROUTER_ERROR,
      } as never),
    ).toMatch(/^⚠️ Daily free-model limit reached/u);
    expect(
      renderRateLimitReplyCopy({ message: "429 Too many requests", reason: "rate_limit" }),
    ).toContain("short break");
  });
});
