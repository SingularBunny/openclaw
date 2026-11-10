import { createHash } from "node:crypto";
import type {
  ProviderFetchUsageSnapshotContext,
  ProviderResolveUsageAuthContext,
  ProviderResolvedUsageAuth,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  addProviderUsageModel,
  asProviderUsageObject,
  buildUsageHttpErrorSnapshot,
  buildProviderUsageHistorySnapshot,
  cleanProviderUsageCredential,
  createProviderUsageDailyAccumulator,
  decodeProviderUsageAdminToken,
  encodeProviderUsageAdminToken,
  fetchProviderUsagePages,
  fetchClaudeUsage,
  parseProviderUsageNonNegativeInteger,
  parseProviderUsageNumber,
  resolveProviderUsageDailyPeriod,
  resolveProviderUsageDisplayName,
  type ProviderUsageSnapshot,
} from "openclaw/plugin-sdk/provider-usage";
import { isTransientNetworkError, sleepWithAbort } from "openclaw/plugin-sdk/retry-runtime";
import { CLAUDE_CLI_BACKEND_ID, CLAUDE_CLI_PROFILE_ID } from "./cli-constants.js";

const ANTHROPIC_COST_URL = "https://api.anthropic.com/v1/organizations/cost_report";
const ANTHROPIC_MESSAGES_USAGE_URL =
  "https://api.anthropic.com/v1/organizations/usage_report/messages";
const ANTHROPIC_ADMIN_TOKEN_PREFIX = "openclaw:anthropic-admin:v1:";
const ANTHROPIC_USAGE_RESPONSE_MAX_BYTES = 4 * 1024 * 1024;
const ANTHROPIC_USAGE_HISTORY_DAYS = 30;
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

function normalizeAdminKey(raw: string | undefined): string | undefined {
  const cleaned = cleanProviderUsageCredential(raw);
  if (!cleaned) {
    return undefined;
  }
  const withoutBearer = cleaned.toLowerCase().startsWith("bearer ")
    ? cleaned.slice("bearer ".length).trim()
    : cleaned;
  return withoutBearer.toLowerCase().startsWith("sk-ant-admin") ? withoutBearer : undefined;
}

function encodeAdminToken(token: string): string {
  return encodeProviderUsageAdminToken(ANTHROPIC_ADMIN_TOKEN_PREFIX, token);
}

function utcDay(value: string): string | undefined {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : undefined;
}

async function fetchPages(params: {
  baseUrl: string;
  groupBy: "description" | "model";
  apiKey: string;
  startingAt: string;
  endingAt: string;
  periodDays: number;
  timeoutMs: number;
  fetchFn: typeof fetch;
}): Promise<{ ok: true; data: unknown[] } | { ok: false; status?: number }> {
  return await fetchProviderUsagePages({
    responseLabel: "Anthropic usage",
    responseMaxBytes: ANTHROPIC_USAGE_RESPONSE_MAX_BYTES,
    timeoutMs: params.timeoutMs,
    fetchFn: params.fetchFn,
    buildRequest: (page) => {
      const url = new URL(params.baseUrl);
      url.searchParams.set("starting_at", params.startingAt);
      url.searchParams.set("ending_at", params.endingAt);
      url.searchParams.set("bucket_width", "1d");
      url.searchParams.set("limit", String(params.periodDays));
      url.searchParams.set("group_by[]", params.groupBy);
      if (page) {
        url.searchParams.set("page", page);
      }
      return {
        url,
        headers: {
          Accept: "application/json",
          "anthropic-version": "2023-06-01",
          "x-api-key": params.apiKey,
        },
      };
    },
  });
}

function aggregateHistory(params: {
  costs: unknown[];
  messages: unknown[];
  periodDays: number;
}): ProviderUsageSnapshot {
  const daily = new Map<string, ReturnType<typeof createProviderUsageDailyAccumulator>>();
  const getDaily = (startingAt: string) => {
    const date = utcDay(startingAt);
    if (!date) {
      return undefined;
    }
    const current = daily.get(date) ?? createProviderUsageDailyAccumulator(date);
    daily.set(date, current);
    return current;
  };

  for (const rawBucket of params.costs) {
    const bucket = asProviderUsageObject(rawBucket);
    const startingAt = typeof bucket?.starting_at === "string" ? bucket.starting_at : undefined;
    if (!startingAt || !Array.isArray(bucket?.results)) {
      continue;
    }
    const accumulator = getDaily(startingAt);
    if (!accumulator) {
      continue;
    }
    for (const rawResult of bucket.results) {
      const result = asProviderUsageObject(rawResult);
      const amount = (parseProviderUsageNumber(result?.amount) ?? 0) / 100;
      const category = resolveProviderUsageDisplayName(
        result?.description ?? result?.cost_type,
        "Claude API",
      );
      accumulator.amount += amount;
      accumulator.categories.set(category, (accumulator.categories.get(category) ?? 0) + amount);
    }
  }

  for (const rawBucket of params.messages) {
    const bucket = asProviderUsageObject(rawBucket);
    const startingAt = typeof bucket?.starting_at === "string" ? bucket.starting_at : undefined;
    if (!startingAt || !Array.isArray(bucket?.results)) {
      continue;
    }
    const accumulator = getDaily(startingAt);
    if (!accumulator) {
      continue;
    }
    for (const rawResult of bucket.results) {
      const result = asProviderUsageObject(rawResult);
      if (!result) {
        continue;
      }
      const cacheCreation = asProviderUsageObject(result.cache_creation);
      const inputTokens = parseProviderUsageNonNegativeInteger(result.uncached_input_tokens);
      const cacheWriteTokens =
        parseProviderUsageNonNegativeInteger(cacheCreation?.ephemeral_1h_input_tokens) +
        parseProviderUsageNonNegativeInteger(cacheCreation?.ephemeral_5m_input_tokens);
      const cacheReadTokens = parseProviderUsageNonNegativeInteger(result.cache_read_input_tokens);
      const outputTokens = parseProviderUsageNonNegativeInteger(result.output_tokens);
      const totalTokens = inputTokens + cacheWriteTokens + cacheReadTokens + outputTokens;
      accumulator.inputTokens += inputTokens;
      accumulator.cacheWriteTokens += cacheWriteTokens;
      accumulator.cacheReadTokens += cacheReadTokens;
      accumulator.outputTokens += outputTokens;
      accumulator.totalTokens += totalTokens;
      addProviderUsageModel(
        accumulator,
        resolveProviderUsageDisplayName(result.model, "Claude API"),
        {
          inputTokens,
          cacheReadTokens,
          cacheWriteTokens,
          outputTokens,
          totalTokens,
        },
      );
    }
  }

  return buildProviderUsageHistorySnapshot({
    provider: "anthropic",
    displayName: "Anthropic",
    plan: "Admin API",
    periodDays: params.periodDays,
    unit: "USD",
    daily: daily.values(),
    formatSummary: ({ totalTokens }) => `${totalTokens.toLocaleString("en-US")} tokens`,
  });
}

async function fetchAnthropicAdminUsage(params: {
  apiKey: string;
  timeoutMs: number;
  fetchFn: typeof fetch;
}): Promise<ProviderUsageSnapshot> {
  const period = resolveProviderUsageDailyPeriod({
    now: Date.now(),
    defaultPeriodDays: ANTHROPIC_USAGE_HISTORY_DAYS,
  });
  const common = {
    apiKey: params.apiKey,
    startingAt: new Date(period.startMs).toISOString(),
    endingAt: new Date(period.endMs).toISOString(),
    periodDays: period.periodDays,
    timeoutMs: params.timeoutMs,
    fetchFn: params.fetchFn,
  };
  const [costs, messages] = await Promise.all([
    fetchPages({ ...common, baseUrl: ANTHROPIC_COST_URL, groupBy: "description" }),
    fetchPages({ ...common, baseUrl: ANTHROPIC_MESSAGES_USAGE_URL, groupBy: "model" }),
  ]);
  if (!costs.ok || !messages.ok) {
    const failedStatus = !costs.ok ? costs.status : !messages.ok ? messages.status : undefined;
    if (failedStatus === 401 || failedStatus === 403) {
      return {
        provider: "anthropic",
        displayName: "Anthropic",
        windows: [],
        error: "Admin API key required",
      };
    }
    return failedStatus
      ? buildUsageHttpErrorSnapshot({ provider: "anthropic", status: failedStatus })
      : {
          provider: "anthropic",
          displayName: "Anthropic",
          windows: [],
          error: "Usage unavailable",
        };
  }
  return aggregateHistory({
    costs: costs.data,
    messages: messages.data,
    periodDays: period.periodDays,
  });
}

export async function resolveAnthropicUsageAuth(
  ctx: ProviderResolveUsageAuthContext,
): Promise<ProviderResolvedUsageAuth> {
  const explicitAdminKey =
    cleanProviderUsageCredential(ctx.env.ANTHROPIC_ADMIN_KEY) ??
    cleanProviderUsageCredential(ctx.env.ANTHROPIC_ADMIN_API_KEY);
  if (explicitAdminKey) {
    return { token: encodeAdminToken(explicitAdminKey) };
  }

  const storedCandidates = (await ctx.resolveApiKeyCandidatesFromConfigAndStore?.()) ?? [];
  const storedAdminKey = storedCandidates
    .map(normalizeAdminKey)
    .find((candidate): candidate is string => Boolean(candidate));
  if (storedAdminKey) {
    return { token: encodeAdminToken(storedAdminKey) };
  }

  const oauthToken = await ctx.resolveOAuthToken({
    excludeProfileIds: [CLAUDE_CLI_PROFILE_ID],
  });
  if (oauthToken) {
    return oauthToken;
  }

  const apiKey = storedCandidates[0];
  if (apiKey) {
    const { validateAnthropicSetupToken } = await import("openclaw/plugin-sdk/provider-auth");
    if (validateAnthropicSetupToken(apiKey) === undefined) {
      return { token: apiKey };
    }
  }

  // Fork: when models run through the Claude CLI backend, read Claude CLI's own login
  // read-only. The access token is used only while valid and never refreshed here: Claude
  // owns its refresh-token family, and a generic refresh would invalidate Claude's login.
  if (ctx.cliBackendsInUse?.includes(CLAUDE_CLI_BACKEND_ID)) {
    const native = await readClaudeCliUsageToken();
    if (native) {
      return native;
    }
  }

  // Claude owns its native refresh-token family. Do not resolve a copied
  // claude-cli profile here: generic OAuth refresh invalidates Claude's login.
  return { handled: true };
}

async function readClaudeCliUsageToken(
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
async function fetchClaudeSubscriptionUsage(
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

/** Formats keychain plan metadata like ("max", "default_max_20x") as "Max (20x)". */
function resolveClaudePlanLabel(ctx: ProviderFetchUsageSnapshotContext): string | undefined {
  const base = ctx.subscriptionType?.trim();
  if (!base) {
    return undefined;
  }
  const label = base.charAt(0).toUpperCase() + base.slice(1);
  const tier = ctx.rateLimitTier?.trim().match(/_(\d+x)$/i)?.[1];
  return tier ? `${label} (${tier})` : label;
}

export async function fetchAnthropicUsage(
  ctx: ProviderFetchUsageSnapshotContext,
): Promise<ProviderUsageSnapshot> {
  const adminKey = decodeProviderUsageAdminToken(ANTHROPIC_ADMIN_TOKEN_PREFIX, ctx.token);
  if (adminKey) {
    return await fetchAnthropicAdminUsage({
      apiKey: adminKey,
      timeoutMs: ctx.timeoutMs,
      fetchFn: ctx.fetchFn,
    });
  }
  const snapshot = await fetchClaudeSubscriptionUsage(ctx);
  if (snapshot.error) {
    return snapshot;
  }
  // Identity comes from the selected credential, so ambient config cannot mislabel an account.
  const accountEmail = ctx.email;
  // Plan labels stay window-gated: a windowless response has no plan quota to
  // label, while the account identity is still worth surfacing.
  const plan =
    snapshot.plan ?? (snapshot.windows.length > 0 ? resolveClaudePlanLabel(ctx) : undefined);
  return {
    ...snapshot,
    ...(plan ? { plan } : {}),
    ...(accountEmail ? { accountEmail } : {}),
  };
}
