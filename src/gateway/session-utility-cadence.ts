/**
 * Fork: how often the utility model is called for a running chat. Both settings are read on
 * use; a missing, non-positive or non-integer value keeps the upstream default.
 */
const UPSTREAM_OBSERVER_MIN_DIGEST_INTERVAL_MS = 12_000;
const UPSTREAM_ACTIVITY_RECAP_REFRESH_MS = 90_000;

function envPositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value?.trim() || Number.NaN);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** OPENCLAW_SESSION_OBSERVER_MIN_INTERVAL_MS: minimum gap between live progress digests of a run. */
export function resolveSessionObserverMinDigestIntervalMs(env: NodeJS.ProcessEnv = process.env) {
  return envPositiveInt(
    env.OPENCLAW_SESSION_OBSERVER_MIN_INTERVAL_MS,
    UPSTREAM_OBSERVER_MIN_DIGEST_INTERVAL_MS,
  );
}

/**
 * OPENCLAW_ACTIVITY_RECAP_MIN_INTERVAL_MS: minimum gap between recaps that transcript growth
 * requests while a run goes on, and between recaps the Activity page requests (counted from the
 * stored recap after a restart). Run ends, archive and **Retry recap** stay immediate.
 */
export function resolveActivityRecapRefreshMs(env: NodeJS.ProcessEnv = process.env) {
  return envPositiveInt(
    env.OPENCLAW_ACTIVITY_RECAP_MIN_INTERVAL_MS,
    UPSTREAM_ACTIVITY_RECAP_REFRESH_MS,
  );
}

/** Short name for the observer's call sites. */
export const observerDigestIntervalMs = () => resolveSessionObserverMinDigestIntervalMs();
