// Fork: provider plan windows on the Usage page read like the sidebar usage block and claude.ai: the share used
// (not the share left) and an exact countdown to the reset ("in 1h 35m", not a rounded "in 2h").
import type { UsageWindow } from "../../../../src/infra/provider-usage.types.js";
import { registerProviderUsageEnglish } from "../../i18n/locales/en-provider-usage.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { formatClaudeUsageCountdown } from "../claude-usage-indicator-model.ts";

registerEnglishCatalog(registerProviderUsageEnglish);

export function usedWindowPercent(window: UsageWindow): number {
  return Math.round(Math.max(0, Math.min(100, window.usedPercent)));
}

export function usedWindowText(window: UsageWindow): string {
  return t("usage.providerUsage.used", { percent: String(usedWindowPercent(window)) });
}

export function resetCountdownText(resetAt: number, now = Date.now()): string {
  return t("usage.providerUsage.resetsIn", { countdown: formatClaudeUsageCountdown(resetAt, now) });
}
