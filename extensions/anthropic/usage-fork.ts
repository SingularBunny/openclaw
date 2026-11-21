// Fork: Claude subscription usage read from Claude CLI's own login, with HTTP 429 backoff and
// network-level retries. Kept out of usage.ts so upstream changes there merge without conflicts.
import { createHash } from "node:crypto";
import type {
  ProviderFetchUsageSnapshotContext,
  ProviderResolvedUsageAuth,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  buildUsageHttpErrorSnapshot,
  fetchClaudeUsage,
  type ProviderUsageSnapshot,
} from "openclaw/plugin-sdk/provider-usage";
import { isTransientNetworkError, sleepWithAbort } from "openclaw/plugin-sdk/retry-runtime";

/** Fork: grant family marking a usage token read from Claude CLI's own login. */
export const CLAUDE_CLI_USAGE_AUTH_FLOW = "claude-cli-native";
/** A Claude CLI access token this close to expiry is left to Claude CLI to refresh. */
const CLAUDE_CLI_TOKEN_EXPIRY_SKEW_MS = 60_000;
/** Claude CLI credential file reads are reused this long (mtime changes invalidate early). */
const CLAUDE_CLI_CREDENTIAL_TTL_MS = 30_000;
/** Backoff after HTTP 429 from the subscription usage endpoint. */
const USAGE_429_BACKOFF_BASE_MS = 2 * 60_000;
const USAGE_429_BACKOFF_MAX_MS = 15 * 60_000;
/** Fork: delays before the retries of a usage request that failed below HTTP (proxy, TLS). */
const USAGE_NETWORK_RETRY_DELAYS_MS = [500, 1500] as const;

export async function readClaudeCliUsageToken(
  now = Date.now(),
): Promise<ProviderResolvedUsageAuth | null> {
  let credential: ReturnType<
    typeof import("openclaw/plugin-sdk/provider-auth").readClaudeCliCredentialsCached
  >;
  try {
    const { readClaudeCliCredentialsCached } = await import("openclaw/plugin-sdk/provider-auth");
    // File-backed login only: a usage poll must never raise a keychain prompt.
    // The (deprecated) SDK reader is the existing read-only path to Claude CLI's login.
    credential = readClaudeCliCredentialsCached({
      allowKeychainPrompt: false,
      ttlMs: CLAUDE_CLI_CREDENTIAL_TTL_MS,
    });
  } catch {
    return null;
  }
  if (!credential || credential.type === "api_key_helper") {
    return null;
  }
  if (credential.expires - CLAUDE_CLI_TOKEN_EXPIRY_SKEW_MS <= now) {
    // Expired: Claude CLI refreshes on its next run; the following poll picks it up.
    return null;
  }
  const token = credential.type === "oauth" ? credential.access : credential.token;
  return {
    token,
    authFlow: CLAUDE_CLI_USAGE_AUTH_FLOW,
    ...(credential.subscriptionType ? { subscriptionType: credential.subscriptionType } : {}),
    ...(credential.rateLimitTier ? { rateLimitTier: credential.rateLimitTier } : {}),
    ...(credential.email ? { email: credential.email } : {}),
  };
}

type UsageBackoffState = {
  /** Token fingerprint (hash prefix); never the token itself. */
  key: string;
  failures: number;
  until: number;
  lastGood?: ProviderUsageSnapshot;
};

let usageBackoff: UsageBackoffState | undefined;

function fingerprintUsageToken(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

function parseRetryAfterMs(value: string | null, now: number): number | undefined {
  if (!value) {
    return undefined;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

function isUsageNetworkFailure(err: unknown): boolean {
  const name = err instanceof Error ? err.name : undefined;
  // The request deadline and caller cancellation surface as abort/timeout: never retried.
  return name !== "AbortError" && name !== "TimeoutError" && isTransientNetworkError(err);
}

/**
 * Fork: retries a usage request up to twice when it fails before any HTTP response (`fetch
 * failed`, ECONNRESET, TLS handshake errors, e.g. through a flaky proxy). HTTP statuses are never
 * retried here. The retries share the caller's deadline signal, so the timeout budget holds.
 */
async function fetchWithUsageNetworkRetry(
  fetchFn: typeof fetch,
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1],
): Promise<Response> {
  const signal = init?.signal ?? undefined;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fetchFn(input, init);
    } catch (err) {
      const delayMs = USAGE_NETWORK_RETRY_DELAYS_MS[attempt];
      if (delayMs === undefined || signal?.aborted || !isUsageNetworkFailure(err)) {
        throw err;
      }
      try {
        await sleepWithAbort(delayMs, signal);
      } catch {
        throw err;
      }
    }
  }
}

/** Test-only reset of the subscription usage backoff state. */
export function resetAnthropicUsageBackoffForTest(): void {
  usageBackoff = undefined;
}

/**
 * Fork: subscription usage with HTTP 429 backoff. The Gateway already caches usage for a
 * minute; after a 429 this skips the endpoint for 2, 4, 8… (max 15) minutes or Retry-After,
 * serving the last good snapshot for the same login meanwhile. Network-level failures are
 * retried twice within the request deadline (`fetchWithUsageNetworkRetry`).
 */
export async function fetchClaudeSubscriptionUsage(
  ctx: ProviderFetchUsageSnapshotContext,
): Promise<ProviderUsageSnapshot> {
  const now = Date.now();
  const key = fingerprintUsageToken(ctx.token);
  const state = usageBackoff?.key === key ? usageBackoff : undefined;
  if (state && now < state.until) {
    return state.lastGood ?? buildUsageHttpErrorSnapshot({ provider: "anthropic", status: 429 });
  }
  // Observed through the fetch seam: the shared fetcher reports HTTP errors only as text.
  const observed: { rateLimited: boolean; retryAfterMs?: number } = { rateLimited: false };
  const fetchFn: typeof fetch = async (input, init) => {
    const response = await fetchWithUsageNetworkRetry(ctx.fetchFn, input, init);
    if (response.status === 429) {
      observed.rateLimited = true;
      observed.retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"), Date.now());
    }
    return response;
  };
  const snapshot = await fetchClaudeUsage(ctx.token, ctx.timeoutMs, fetchFn);
  if (observed.rateLimited) {
    const failures = (state?.failures ?? 0) + 1;
    const backoffMs = Math.min(
      USAGE_429_BACKOFF_MAX_MS,
      Math.max(observed.retryAfterMs ?? 0, USAGE_429_BACKOFF_BASE_MS * 2 ** (failures - 1)),
    );
    usageBackoff = { key, failures, until: now + backoffMs, lastGood: state?.lastGood };
    return state?.lastGood ?? snapshot;
  }
  if (!snapshot.error) {
    usageBackoff = { key, failures: 0, until: 0, lastGood: snapshot };
  }
  return snapshot;
}
