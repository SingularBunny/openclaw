// Fork: pure view model for the always-visible Claude subscription usage indicator.
import type {
  ProviderUsageRateLimit,
  ProviderUsageSnapshot,
  UsageSummary,
  UsageWindow,
} from "../../../src/infra/provider-usage.types.js";
import { registerClaudeUsageEnglish } from "../i18n/locales/en-claude-usage.ts";

registerClaudeUsageEnglish();

type Translate = (key: string, params?: Record<string, string>) => string;

export type ClaudeUsageTone = "ok" | "warn" | "danger";

export type ClaudeUsageRow = {
  key: string;
  label: string;
  percent: number;
  resetAt?: number;
  tone: ClaudeUsageTone;
};

export type ClaudeUsageView = {
  rows: ClaudeUsageRow[];
  plan?: string;
  /** Present only for a warning or a reached limit from the latest turn. */
  rateLimit?: ProviderUsageRateLimit & { label?: string };
  /** When the shown windows were last read; set only while the latest read had none. */
  staleSince?: number;
};

/** The last read that carried Claude windows, kept across failed or windowless reads. */
export type ClaudeUsageLastGood = { snapshot: ProviderUsageSnapshot; at: number };

/** How long the last good windows stay on screen while reads keep failing. */
export const CLAUDE_USAGE_STALE_KEEP_MS = 6 * 60 * 60 * 1000;

function claudeSnapshot(summary: UsageSummary | null | undefined) {
  return summary?.providers.find((entry) => entry.provider === "anthropic");
}

/** Remembers a read with Claude windows; any other read keeps the previous one. */
export function rememberClaudeUsage(
  previous: ClaudeUsageLastGood | null,
  summary: UsageSummary | null | undefined,
  now: number,
): ClaudeUsageLastGood | null {
  const snapshot = claudeSnapshot(summary);
  return snapshot && !snapshot.error && snapshot.windows.length > 0
    ? { snapshot, at: now }
    : previous;
}

const WARN_PERCENT = 70;
const DANGER_PERCENT = 90;

/** Claude CLI `rateLimitType` ids mapped to the usage window labels the Gateway reports. */
const RATE_LIMIT_WINDOW_LABELS: Record<string, string> = {
  five_hour: "5h",
  seven_day: "Week",
  seven_day_opus: "Opus",
  seven_day_sonnet: "Sonnet",
};

function toneFor(percent: number): ClaudeUsageTone {
  return percent >= DANGER_PERCENT ? "danger" : percent >= WARN_PERCENT ? "warn" : "ok";
}

function windowLabel(window: UsageWindow, t: Translate): string {
  switch (window.label) {
    case "5h":
      return t("common.claudeUsage.fiveHour");
    case "Week":
      return t("common.claudeUsage.week");
    case "Extra usage":
      return t("common.claudeUsage.extra");
    default:
      return window.label;
  }
}

function rateLimitLabel(limitType: string | undefined, t: Translate): string | undefined {
  if (!limitType) {
    return undefined;
  }
  const windowId = RATE_LIMIT_WINDOW_LABELS[limitType];
  if (windowId) {
    return windowLabel({ label: windowId, usedPercent: 0 }, t);
  }
  return limitType === "overage" ? t("common.claudeUsage.extra") : limitType;
}

/**
 * Selects Claude (Anthropic) subscription usage from a usage.status summary. Returns null
 * when there is nothing to show: no Claude snapshot, an error without windows, or only an
 * "allowed" turn status without windows.
 */
export function resolveClaudeUsageView(
  summary: UsageSummary | null | undefined,
  now: number,
  t: Translate,
  lastGood?: ClaudeUsageLastGood | null,
): ClaudeUsageView | null {
  const latest = claudeSnapshot(summary);
  // An expired Claude CLI token, a timeout or a 5xx drop the windows for a while; the last
  // good ones stay, marked with their age, instead of the block vanishing.
  const stale =
    (!latest || latest.windows.length === 0) &&
    lastGood !== undefined &&
    lastGood !== null &&
    now - lastGood.at < CLAUDE_USAGE_STALE_KEEP_MS
      ? lastGood
      : undefined;
  const snapshot = stale
    ? { ...stale.snapshot, rateLimit: latest?.rateLimit ?? stale.snapshot.rateLimit }
    : latest;
  if (!snapshot) {
    return null;
  }
  const live =
    snapshot.rateLimit &&
    snapshot.rateLimit.status !== "allowed" &&
    (snapshot.rateLimit.resetAt === undefined || snapshot.rateLimit.resetAt > now)
      ? snapshot.rateLimit
      : undefined;
  const rejectedWindow = live?.status === "rejected" ? live.limitType : undefined;
  const rejectedLabel = rejectedWindow ? RATE_LIMIT_WINDOW_LABELS[rejectedWindow] : undefined;
  const rows = snapshot.windows.map((window, index): ClaudeUsageRow => {
    // A turn rejected on this window is newer than the minute-cached percentage.
    const rejected = rejectedLabel !== undefined && window.label === rejectedLabel;
    const percent = rejected ? 100 : Math.round(Math.min(100, Math.max(0, window.usedPercent)));
    const resetAt = rejected && live?.resetAt !== undefined ? live.resetAt : window.resetAt;
    return {
      key: `${index}:${window.label}`,
      label: windowLabel(window, t),
      percent,
      ...(resetAt !== undefined && resetAt > now ? { resetAt } : {}),
      tone: toneFor(percent),
    };
  });
  if (rows.length === 0 && !live) {
    return null;
  }
  const label = rateLimitLabel(live?.limitType, t);
  return {
    rows,
    ...(snapshot.plan ? { plan: snapshot.plan } : {}),
    ...(live ? { rateLimit: { ...live, ...(label ? { label } : {}) } } : {}),
    ...(stale ? { staleSince: stale.at } : {}),
  };
}

/** Compact countdown such as "2h 15m", "3d 4h" or "<1m". */
export function formatClaudeUsageCountdown(resetAt: number, now: number): string {
  const minutes = Math.max(0, Math.floor((resetAt - now) / 60_000));
  if (minutes < 1) {
    return "<1m";
  }
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) {
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  }
  if (hours > 0) {
    return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  }
  return `${mins}m`;
}
