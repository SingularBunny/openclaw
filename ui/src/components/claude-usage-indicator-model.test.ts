import { describe, expect, it } from "vitest";
import {
  CLAUDE_USAGE_STALE_KEEP_MS,
  formatClaudeUsageCountdown,
  rememberClaudeUsage,
  rememberProviderUsage,
  resolveClaudeUsageView,
  resolveProviderUsageViews,
} from "./claude-usage-indicator-model.ts";

const NOW = Date.parse("2026-11-10T12:00:00Z");
const t = (key: string, params?: Record<string, string>) =>
  params ? `${key}:${JSON.stringify(params)}` : key;

describe("Claude usage indicator model", () => {
  it("is hidden without Claude subscription data", () => {
    expect(resolveClaudeUsageView(null, NOW, t)).toBeNull();
    expect(
      resolveClaudeUsageView(
        {
          updatedAt: NOW,
          providers: [{ provider: "openrouter", displayName: "OpenRouter", windows: [] }],
        },
        NOW,
        t,
      ),
    ).toBeNull();
    expect(
      resolveClaudeUsageView(
        {
          updatedAt: NOW,
          providers: [
            { provider: "anthropic", displayName: "Claude", windows: [], error: "HTTP 401" },
          ],
        },
        NOW,
        t,
      ),
    ).toBeNull();
  });

  it("builds bars with tones, labels and future resets only", () => {
    const view = resolveClaudeUsageView(
      {
        updatedAt: NOW,
        providers: [
          {
            provider: "anthropic",
            displayName: "Claude",
            plan: "Max (20x)",
            windows: [
              { label: "5h", usedPercent: 12.4, resetAt: NOW + 3_600_000 },
              { label: "Week", usedPercent: 75, resetAt: NOW - 1 },
              { label: "Opus", usedPercent: 140 },
            ],
          },
        ],
      },
      NOW,
      t,
    );
    expect(view).toEqual({
      plan: "Max (20x)",
      rows: [
        {
          key: "0:5h",
          label: "common.claudeUsage.fiveHour",
          percent: 12,
          resetAt: NOW + 3_600_000,
          tone: "ok",
        },
        { key: "1:Week", label: "common.claudeUsage.week", percent: 75, tone: "warn" },
        { key: "2:Opus", label: "Opus", percent: 100, tone: "danger" },
      ],
    });
  });

  it("lets a rejected turn override the cached window and show its reset", () => {
    const view = resolveClaudeUsageView(
      {
        updatedAt: NOW,
        providers: [
          {
            provider: "anthropic",
            displayName: "Claude",
            windows: [{ label: "5h", usedPercent: 80, resetAt: NOW + 60_000 }],
            rateLimit: {
              status: "rejected",
              limitType: "five_hour",
              resetAt: NOW + 7_200_000,
              observedAt: NOW,
            },
          },
        ],
      },
      NOW,
      t,
    );
    expect(view?.rows[0]).toMatchObject({ percent: 100, tone: "danger", resetAt: NOW + 7_200_000 });
    expect(view?.rateLimit).toMatchObject({
      status: "rejected",
      label: "common.claudeUsage.fiveHour",
    });
  });

  it("shows a live limit even before usage windows are available, but not a plain allowed", () => {
    const summary = (status: "allowed" | "rejected") => ({
      updatedAt: NOW,
      providers: [
        {
          provider: "anthropic",
          displayName: "Claude",
          windows: [],
          rateLimit: { status, observedAt: NOW },
        },
      ],
    });
    expect(resolveClaudeUsageView(summary("allowed"), NOW, t)).toBeNull();
    expect(resolveClaudeUsageView(summary("rejected"), NOW, t)?.rateLimit?.status).toBe("rejected");
  });

  it("keeps the last good windows, marked stale, while reads fail", () => {
    const good = {
      updatedAt: NOW,
      providers: [
        {
          provider: "anthropic",
          displayName: "Claude",
          windows: [{ label: "5h", usedPercent: 40, resetAt: NOW + 3_600_000 }],
        },
      ],
    };
    const failed = {
      updatedAt: NOW,
      providers: [{ provider: "anthropic", displayName: "Claude", windows: [], error: "HTTP 500" }],
    };
    const missing = { updatedAt: NOW, providers: [] };
    const lastGood = rememberClaudeUsage(null, good, NOW);
    expect(rememberClaudeUsage(lastGood, failed, NOW + 60_000)).toBe(lastGood);
    expect(resolveClaudeUsageView(good, NOW, t, lastGood)?.staleSince).toBeUndefined();
    for (const summary of [failed, missing]) {
      const view = resolveClaudeUsageView(summary, NOW + 60_000, t, lastGood);
      expect(view?.rows.map((row) => row.percent)).toEqual([40]);
      expect(view?.staleSince).toBe(NOW);
    }
    expect(
      resolveClaudeUsageView(failed, NOW + CLAUDE_USAGE_STALE_KEEP_MS, t, lastGood),
    ).toBeNull();
  });

  // Fork (V1): the sidebar shows every provider with usage windows, Claude first.
  it("lists every provider with windows, Claude first, each kept while its reads fail", () => {
    const openai = {
      provider: "openai",
      displayName: "OpenAI",
      plan: "Plus",
      windows: [{ label: "5h", usedPercent: 20 }],
    };
    const claude = {
      provider: "anthropic",
      displayName: "Claude",
      windows: [{ label: "Week", usedPercent: 50 }],
    };
    const keyOnly = { provider: "deepseek", displayName: "DeepSeek", windows: [], error: "No key" };
    const both = { updatedAt: NOW, providers: [openai, keyOnly, claude] };
    const views = resolveProviderUsageViews(both, NOW, t);
    expect(views.map((view) => [view.provider, view.displayName, view.plan])).toEqual([
      ["anthropic", "Claude", undefined],
      ["openai", "OpenAI", "Plus"],
    ]);
    expect(views[1]?.rows).toEqual([
      { key: "0:5h", label: "common.claudeUsage.fiveHour", percent: 20, tone: "ok" },
    ]);

    const lastGood = rememberProviderUsage({}, both, NOW);
    expect(Object.keys(lastGood).toSorted()).toEqual(["anthropic", "openai"]);
    const openaiFailed = {
      updatedAt: NOW,
      providers: [claude, { ...openai, windows: [], error: "HTTP 500" }],
    };
    expect(rememberProviderUsage(lastGood, openaiFailed, NOW + 60_000)["openai"]).toBe(
      lastGood["openai"],
    );
    const stale = resolveProviderUsageViews(openaiFailed, NOW + 60_000, t, lastGood);
    expect(stale.map((view) => [view.provider, view.staleSince])).toEqual([
      ["anthropic", undefined],
      ["openai", NOW],
    ]);
    expect(resolveProviderUsageViews(null, NOW, t)).toEqual([]);
  });

  // Fork: a provider with a balance and no windows (an ACP agent's credits, a prepaid key).
  it("shows a balance-only provider, zero in danger, and keeps windows compact", () => {
    const junie = {
      provider: "acp-junie",
      displayName: "Junie",
      windows: [],
      plan: "JetBrains AI Ultimate",
      billing: [
        { type: "balance" as const, label: "Balance left", amount: 30.54, unit: "credits" },
      ],
      usageOnly: true,
    };
    const deepseek = {
      provider: "deepseek",
      displayName: "DeepSeek",
      windows: [],
      plan: "Unavailable",
      billing: [{ type: "balance" as const, amount: 0, unit: "USD" }],
    };
    const openrouter = {
      provider: "openrouter",
      displayName: "OpenRouter",
      windows: [{ label: "API key budget", usedPercent: 40 }],
      billing: [{ type: "balance" as const, amount: 12, unit: "USD" }],
    };
    const failed = { provider: "acp-codex", displayName: "Codex", windows: [], error: "timeout" };
    const summary = {
      updatedAt: NOW,
      providers: [junie, deepseek, openrouter, failed],
    } as Parameters<typeof resolveProviderUsageViews>[0];
    const views = resolveProviderUsageViews(summary, NOW, t);
    expect(views.map((view) => [view.provider, view.plan, view.rows.length, view.balance])).toEqual(
      [
        [
          "acp-junie",
          "JetBrains AI Ultimate",
          0,
          { label: "Balance left", amount: "30.54 credits", tone: "ok" },
        ],
        [
          "deepseek",
          "Unavailable",
          0,
          { label: "common.claudeUsage.balance", amount: "$0.00", tone: "danger" },
        ],
        ["openrouter", undefined, 1, undefined],
      ],
    );

    // A balance read is remembered like a read with windows and stays while reads fail.
    const lastGood = rememberProviderUsage({}, summary, NOW);
    expect(Object.keys(lastGood).toSorted()).toEqual(["acp-junie", "deepseek", "openrouter"]);
    const junieFailed = {
      updatedAt: NOW,
      providers: [{ ...junie, billing: undefined, error: "probe timed out" }],
    } as Parameters<typeof resolveProviderUsageViews>[0];
    expect(rememberProviderUsage(lastGood, junieFailed, NOW + 60_000)["acp-junie"]).toBe(
      lastGood["acp-junie"],
    );
    const stale = resolveProviderUsageViews(junieFailed, NOW + 60_000, t, {
      "acp-junie": lastGood["acp-junie"],
    });
    expect(stale.map((view) => [view.provider, view.staleSince, view.balance?.amount])).toEqual([
      ["acp-junie", NOW, "30.54 credits"],
    ]);
  });

  it("formats compact countdowns", () => {
    expect(formatClaudeUsageCountdown(NOW + 20_000, NOW)).toBe("<1m");
    expect(formatClaudeUsageCountdown(NOW + 45 * 60_000, NOW)).toBe("45m");
    expect(formatClaudeUsageCountdown(NOW + 135 * 60_000, NOW)).toBe("2h 15m");
    expect(formatClaudeUsageCountdown(NOW + (3 * 1440 + 240) * 60_000, NOW)).toBe("3d 4h");
  });
});
