// Fork (F48): the Claude usage the sidebar indicator last resolved, shared with the composer
// status line so both show the same figures without a second usage.status poll.
import { createSignal } from "solid-js";
import type { ClaudeUsageView } from "./claude-usage-indicator-model.ts";

const [claudeUsageView, setClaudeUsageView] = createSignal<ClaudeUsageView | null>(null, {
  // Published from the indicator's render effect.
  ownedWrite: true,
});

/** The latest Claude usage view; null while the indicator is not mounted or has no data. */
export function readSharedClaudeUsage(): ClaudeUsageView | null {
  return claudeUsageView();
}

export function publishSharedClaudeUsage(view: ClaudeUsageView | null): void {
  setClaudeUsageView(() => view);
}
