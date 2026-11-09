import { readSessionActivitySummary } from "../config/sessions/activity-summary.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { ActivitySummaryTarget } from "./session-activity-summary-state.js";

/**
 * Fork (F41): an Activity recap request. `immediate: false` (Activity page requests) keeps the
 * per-session minimum interval OPENCLAW_ACTIVITY_RECAP_MIN_INTERVAL_MS and serves the stored recap
 * meanwhile; omitted or true (**Retry recap**, other callers) starts at once, as upstream.
 */
export type RecapEnsureTarget = ActivitySummaryTarget & { immediate?: boolean };

/**
 * Returns whether an ensure request starts a recap at once. A throttled request on a fresh tracker
 * (after a Gateway restart nothing remembers the last start) counts the interval from the stored
 * recap of the same session, so opening the Activity page does not recap every stale row at once
 * (09.11.2026: 175 utility-model calls in 35 minutes after a restart).
 */
export function ensureRecapNow(
  state: { sessionId: string; lastStartedAt: number; entry: SessionEntry | undefined },
  request: { immediate?: boolean },
  nowMs: number,
): boolean {
  if (request.immediate !== false) {
    return true;
  }
  const stored = readSessionActivitySummary(state.entry);
  if (stored?.sessionId === state.sessionId && typeof stored.updatedAt === "number") {
    state.lastStartedAt = Math.max(state.lastStartedAt, Math.min(stored.updatedAt, nowMs));
  }
  return false;
}
