import { afterEach, describe, expect, it } from "vitest";
import {
  clearProviderUsageRateLimitsForTest,
  overlayProviderUsageRateLimits,
  readProviderUsageRateLimits,
  recordProviderUsageRateLimit,
} from "./provider-usage.rate-limit.js";

const NOW = Date.parse("2026-11-10T12:00:00Z");

describe("provider usage rate-limit state", () => {
  afterEach(() => clearProviderUsageRateLimitsForTest());

  it("keeps the latest valid status until its reset passes", () => {
    expect(recordProviderUsageRateLimit({ provider: "anthropic", status: "bogus" })).toBe(false);
    recordProviderUsageRateLimit({
      provider: "anthropic",
      status: "allowed_warning",
      limitType: "five_hour",
      resetAt: NOW + 60_000,
      observedAt: NOW - 1_000,
    });
    recordProviderUsageRateLimit({
      provider: "anthropic",
      status: "rejected",
      limitType: "five_hour",
      resetAt: NOW + 120_000,
      observedAt: NOW,
    });
    expect(readProviderUsageRateLimits(NOW).get("anthropic")).toEqual({
      status: "rejected",
      limitType: "five_hour",
      resetAt: NOW + 120_000,
      observedAt: NOW,
    });
    expect(readProviderUsageRateLimits(NOW + 120_000).size).toBe(0);
  });

  it("expires a status without a reset time after six hours", () => {
    recordProviderUsageRateLimit({ provider: "anthropic", status: "allowed", observedAt: NOW });
    expect(readProviderUsageRateLimits(NOW + 60_000).size).toBe(1);
    expect(readProviderUsageRateLimits(NOW + 6 * 60 * 60_000).size).toBe(0);
  });

  it("overlays live status onto cached snapshots and adds a window-less entry", () => {
    recordProviderUsageRateLimit({
      provider: "anthropic",
      status: "rejected",
      limitType: "seven_day",
      resetAt: NOW + 3_600_000,
      observedAt: NOW,
    });
    const cached = {
      updatedAt: NOW - 30_000,
      providers: [{ provider: "openrouter", displayName: "OpenRouter", windows: [] }],
    };
    const overlaid = overlayProviderUsageRateLimits(cached, NOW);
    expect(overlaid.providers).toEqual([
      cached.providers[0],
      {
        provider: "anthropic",
        displayName: "Claude",
        windows: [],
        rateLimit: {
          status: "rejected",
          limitType: "seven_day",
          resetAt: NOW + 3_600_000,
          observedAt: NOW,
        },
      },
    ]);
    // The cached summary itself is not mutated.
    expect(cached.providers).toHaveLength(1);
  });

  it("does not grow an incomplete cold summary", () => {
    recordProviderUsageRateLimit({ provider: "anthropic", status: "rejected", observedAt: NOW });
    const cold = { updatedAt: NOW, providers: [], refreshing: true };
    expect(overlayProviderUsageRateLimits(cold, NOW)).toEqual({ ...cold, providers: [] });
  });
});
