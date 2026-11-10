import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

// Fork: the always-visible Claude subscription usage indicator in the sidebar.
const catalog = {
  common: {
    claudeUsage: {
      title: "Claude usage",
      titleWithPlan: "Claude usage · {plan}",
      fiveHour: "5h",
      week: "Week",
      extra: "Extra",
      percentUsed: "{label}: {percent}% used",
      resetsIn: "resets in {countdown}",
      resetsAt: "Resets {relative} ({time})",
      limitReached: "Limit reached",
      limitReachedWindow: "{label} limit reached",
      approaching: "Approaching limit",
      approachingWindow: "Approaching {label} limit",
      openUsage: "Open usage",
      updated: "updated {relative}",
    },
  },
} satisfies TranslationMap;

export const registerClaudeUsageEnglish = Object.assign(
  () => {
    Object.assign(en.common as Record<string, unknown>, catalog.common);
  },
  { catalog },
);
