import { readSessionActivitySummary } from "../config/sessions/activity-summary.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { ActivitySummaryTarget } from "./session-activity-summary-state.js";
import { resolveActivityRecapRefreshMs } from "./session-utility-cadence.js";

/**
 * Fork (F41): an Activity recap request. `immediate: false` (Activity page requests) keeps the
 * per-session minimum interval OPENCLAW_ACTIVITY_RECAP_MIN_INTERVAL_MS and serves the stored recap
 * meanwhile; omitted or true (**Retry recap**, run end, archive) starts at once, as upstream.
 */
export type RecapEnsureTarget = ActivitySummaryTarget & { immediate?: boolean };

/**
 * Earliest time a recap request may start. The interval counts from the stored recap of the same
 * session, which survives a Gateway restart, so opening the Activity page after a restart does not
 * recap every stale row at once (09.11.2026: 175 utility-model calls in 35 minutes).
 */
export function recapNotBefore(
  state: { sessionId: string; entry: SessionEntry | undefined },
  request: { immediate?: boolean },
  nowMs: number,
): number {
  if (request.immediate !== false) {
    return 0;
  }
  const stored = readSessionActivitySummary(state.entry);
  return stored?.sessionId === state.sessionId && typeof stored.updatedAt === "number"
    ? Math.min(stored.updatedAt, nowMs) + resolveActivityRecapRefreshMs()
    : 0;
}
