// Fork: live subscription rate-limit status observed on model turns (for example Claude CLI
// `rate_limit_event`). Usage endpoints are polled at most once a minute; this state lets
// usage.status report "limit reached / resets at" as soon as a turn sees it.
import { providerUsageLabel } from "./provider-usage.shared.js";
import type {
  ProviderUsageRateLimit,
  UsageProviderId,
  UsageSummary,
} from "./provider-usage.types.js";

const RATE_LIMIT_STATUSES = new Set<ProviderUsageRateLimit["status"]>([
  "allowed",
  "allowed_warning",
  "rejected",
]);
/** An observation without a reset time stays relevant for at most this long. */
const RATE_LIMIT_TTL_WITHOUT_RESET_MS = 6 * 60 * 60_000;

type RateLimitState = Map<UsageProviderId, ProviderUsageRateLimit>;

// Plugin runtimes can load as separate module copies; one process-wide map keeps a single owner.
const STATE_KEY = Symbol.for("openclaw.providerUsage.rateLimit");

function rateLimitState(): RateLimitState {
  const holder = globalThis as Record<PropertyKey, unknown>;
  const existing = holder[STATE_KEY];
  if (existing instanceof Map) {
    return existing as RateLimitState;
  }
  const created: RateLimitState = new Map();
  holder[STATE_KEY] = created;
  return created;
}

function isExpired(entry: ProviderUsageRateLimit, now: number): boolean {
  return entry.resetAt !== undefined
    ? entry.resetAt <= now
    : now - entry.observedAt >= RATE_LIMIT_TTL_WITHOUT_RESET_MS;
}

/** Records the latest rate-limit status a provider reported on a model turn. */
export function recordProviderUsageRateLimit(params: {
  provider: UsageProviderId;
  status: string;
  limitType?: string;
  resetAt?: number;
  observedAt?: number;
}): boolean {
  const status = params.status as ProviderUsageRateLimit["status"];
  if (!RATE_LIMIT_STATUSES.has(status)) {
    return false;
  }
  const limitType = params.limitType?.trim();
  const resetAt =
    params.resetAt !== undefined && Number.isFinite(params.resetAt) && params.resetAt > 0
      ? params.resetAt
      : undefined;
  rateLimitState().set(params.provider, {
    status,
    ...(limitType ? { limitType: limitType.slice(0, 64) } : {}),
    ...(resetAt !== undefined ? { resetAt } : {}),
    observedAt: params.observedAt ?? Date.now(),
  });
  return true;
}

/** Latest unexpired rate-limit status per provider. */
export function readProviderUsageRateLimits(
  now = Date.now(),
): ReadonlyMap<UsageProviderId, ProviderUsageRateLimit> {
  const state = rateLimitState();
  for (const [provider, entry] of state) {
    if (isExpired(entry, now)) {
      state.delete(provider);
    }
  }
  return new Map(state);
}

/**
 * Adds live rate-limit status to a (possibly cached) usage summary. A provider with a live
 * status but no usage snapshot gets a window-less entry, except while a cold refresh is
 * pending: an incomplete list must stay recognizably incomplete.
 */
export function overlayProviderUsageRateLimits(
  summary: UsageSummary,
  now = Date.now(),
): UsageSummary {
  const live = readProviderUsageRateLimits(now);
  if (live.size === 0) {
    return summary;
  }
  const seen = new Set<UsageProviderId>();
  const providers = summary.providers.map((snapshot) => {
    const rateLimit = live.get(snapshot.provider);
    if (!rateLimit) {
      return snapshot;
    }
    seen.add(snapshot.provider);
    return { ...snapshot, rateLimit };
  });
  if (!summary.refreshing) {
    for (const [provider, rateLimit] of live) {
      if (!seen.has(provider)) {
        providers.push({
          provider,
          displayName: providerUsageLabel(provider) ?? provider,
          windows: [],
          rateLimit,
        });
      }
    }
  }
  return { ...summary, providers };
}

export function clearProviderUsageRateLimitsForTest(): void {
  rateLimitState().clear();
}
