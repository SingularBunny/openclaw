import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CLAUDE_CLI_USAGE_AUTH_FLOW,
  fetchAnthropicUsage,
  resetAnthropicUsageBackoffForTest,
  resolveAnthropicUsageAuth,
} from "./usage.js";

const readClaudeCli = vi.hoisted(() => vi.fn());
vi.mock("openclaw/plugin-sdk/provider-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/provider-auth")>()),
  readClaudeCliCredentialsCached: readClaudeCli,
}));

const requestUrl = (input: string | URL | Request) =>
  new URL(input instanceof Request ? input.url : input);

function resolveAuth(overrides: Partial<Parameters<typeof resolveAnthropicUsageAuth>[0]> = {}) {
  return resolveAnthropicUsageAuth({
    config: {},
    env: {},
    provider: "anthropic",
    resolveApiKeyFromConfigAndStore: () => undefined,
    resolveOAuthToken: async () => null,
    ...overrides,
  });
}

function fetchUsage(overrides: Partial<Parameters<typeof fetchAnthropicUsage>[0]> = {}) {
  return fetchAnthropicUsage({
    config: {},
    env: {},
    provider: "anthropic",
    token: "oauth-token",
    timeoutMs: 5000,
    fetchFn: vi.fn(async () => Response.json({ five_hour: { utilization: 10 } })),
    ...overrides,
  });
}

const report = (results: unknown[]) =>
  Response.json({
    data: [{ starting_at: "2026-07-06T00:00:00Z", ending_at: "2026-07-07T00:00:00Z", results }],
    has_more: false,
  });

it("aggregates provider-reported costs, cache tokens, models, and categories", async () => {
  const fetchFn = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
    const url = requestUrl(input);
    if (url.pathname.endsWith("/organizations/cost_report")) {
      return report([{ amount: "1234", currency: "USD", description: "Claude API" }]);
    }
    return report([
      {
        uncached_input_tokens: 1_000,
        cache_creation: {
          ephemeral_1h_input_tokens: 100,
          ephemeral_5m_input_tokens: 50,
        },
        cache_read_input_tokens: 300,
        output_tokens: 250,
        model: "claude-opus-4-8",
      },
    ]);
  });

  const auth = await resolveAuth({
    env: { ANTHROPIC_ADMIN_API_KEY: "sk-ant-admin-test" },
  });
  if (!("token" in auth) || !auth.token) {
    throw new Error("expected encoded Anthropic Admin API credentials");
  }
  const result = await fetchUsage({
    token: auth.token,
    fetchFn: fetchFn as typeof fetch,
  });

  const tokens = {
    inputTokens: 1_000,
    cacheWriteTokens: 150,
    cacheReadTokens: 300,
    outputTokens: 250,
    totalTokens: 1_700,
  };
  expect(result).toMatchObject({
    plan: "Admin API",
    billing: [{ amount: 12.34, unit: "USD" }],
    costHistory: {
      unit: "USD",
      periodDays: 30,
      daily: [{ date: "2026-07-06", amount: 12.34, ...tokens }],
      models: [{ name: "claude-opus-4-8", ...tokens }],
      categories: [{ name: "Claude API", amount: 12.34 }],
    },
    summary: "1,700 tokens",
  });
  for (const [input, init] of fetchFn.mock.calls) {
    const url = requestUrl(input);
    expect(url.searchParams.get("bucket_width")).toBe("1d");
    expect((init as RequestInit).headers).toMatchObject({
      "anthropic-version": "2023-06-01",
      "x-api-key": "sk-ant-admin-test",
    });
  }
});

it("uses a stored setup token when no Admin API or OAuth credential is available", async () => {
  const token = `sk-ant-oat01-${"a".repeat(80)}`;
  const result = await resolveAuth({
    resolveApiKeyCandidatesFromConfigAndStore: async () => [token],
  });
  expect(result).toEqual({ token });
});

it("prefers a stored Admin API key when normal API and OAuth credentials coexist", async () => {
  const result = await resolveAuth({
    resolveApiKeyFromConfigAndStore: () => "sk-ant-api03-inference",
    resolveApiKeyCandidatesFromConfigAndStore: async () => [
      "sk-ant-api03-inference",
      "sk-ant-admin-billing",
    ],
    resolveOAuthToken: async () => ({ token: "oauth-token" }),
  });
  expect(result).toEqual({
    token: 'openclaw:anthropic-admin:v1:{"token":"sk-ant-admin-billing"}',
  });

  describe("Claude CLI native login (fork)", () => {
    afterEach(() => {
      readClaudeCli.mockReset();
      resetAnthropicUsageBackoffForTest();
    });

    const cliCtx = (cliBackendsInUse?: string[]) => ({
      config: {},
      env: {},
      provider: "anthropic",
      ...(cliBackendsInUse ? { cliBackendsInUse } : {}),
      resolveApiKeyFromConfigAndStore: () => undefined,
      resolveOAuthToken: async () => null,
    });

    it("uses a valid Claude CLI access token read-only when the claude-cli backend is in use", async () => {
      readClaudeCli.mockReturnValue({
        type: "oauth",
        provider: "anthropic",
        access: "cli-access",
        refresh: "cli-refresh",
        expires: Date.now() + 3_600_000,
        subscriptionType: "max",
        rateLimitTier: "default_claude_max_20x",
        email: "owner@example.com",
      });
      expect(await resolveAnthropicUsageAuth(cliCtx(["claude-cli"]))).toEqual({
        token: "cli-access",
        authFlow: CLAUDE_CLI_USAGE_AUTH_FLOW,
        subscriptionType: "max",
        rateLimitTier: "default_claude_max_20x",
        email: "owner@example.com",
      });
      expect(readClaudeCli).toHaveBeenCalledWith(
        expect.objectContaining({ allowKeychainPrompt: false }),
      );
    });

    it("leaves an expiring Claude CLI token to Claude CLI instead of refreshing it", async () => {
      readClaudeCli.mockReturnValue({
        type: "oauth",
        provider: "anthropic",
        access: "cli-access",
        refresh: "cli-refresh",
        expires: Date.now() + 30_000,
      });
      expect(await resolveAnthropicUsageAuth(cliCtx(["claude-cli"]))).toEqual({ handled: true });
    });

    it("does not read Claude CLI login unless the claude-cli backend is in use", async () => {
      expect(await resolveAnthropicUsageAuth(cliCtx())).toEqual({ handled: true });
      expect(readClaudeCli).not.toHaveBeenCalled();
    });

    it("backs off after HTTP 429 and serves the last good snapshot meanwhile", async () => {
      let status = 200;
      const fetchFn = vi.fn(async () =>
        status === 200
          ? new Response(
              JSON.stringify({ five_hour: { utilization: 42, resets_at: "2099-01-01T00:00:00Z" } }),
              { status: 200 },
            )
          : new Response(JSON.stringify({ error: { message: "rate limited" } }), {
              status: 429,
              headers: { "retry-after": "600" },
            }),
      );
      const usageCtx = {
        config: {},
        env: {},
        provider: "anthropic",
        token: "cli-access",
        timeoutMs: 5000,
        fetchFn,
      };
      const first = await fetchAnthropicUsage(usageCtx);
      expect(first.windows[0]).toMatchObject({ label: "5h", usedPercent: 42 });
      status = 429;
      const limited = await fetchAnthropicUsage(usageCtx);
      expect(limited.error).toBeUndefined();
      expect(limited.windows[0]).toMatchObject({ usedPercent: 42 });
      expect(fetchFn).toHaveBeenCalledTimes(2);
      // Within the backoff the endpoint is not called again.
      await fetchAnthropicUsage(usageCtx);
      expect(fetchFn).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(limited)).not.toContain("cli-access");
    });
  });
});

it("does not refresh the native Claude login for usage polling", async () => {
  const resolveOAuthToken = vi.fn(async () => null);
  const result = await resolveAuth({
    resolveOAuthToken,
  });
  expect(result).toEqual({ handled: true });
  expect(resolveOAuthToken).toHaveBeenCalledWith({
    excludeProfileIds: ["anthropic:claude-cli"],
  });
});

it.each([
  [{ subscriptionType: "pro", rateLimitTier: "default_pro" }, "plan", "Pro"],
  [{ email: "profile@example.com" }, "accountEmail", "profile@example.com"],
  [{ fetchFn: vi.fn(async () => Response.json({})) }, "plan", undefined],
] as const)("attaches only applicable resolved metadata %j", async (options, field, expected) => {
  const snapshot = await fetchUsage(options);
  expect(snapshot[field]).toBe(expected);
});
