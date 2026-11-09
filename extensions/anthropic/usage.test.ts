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

function requestUrl(input: string | URL | Request): URL {
  return new URL(input instanceof Request ? input.url : input);
}

function oauthFixtureToken(): string {
  return ["oauth", "token"].join("-");
}

describe("Anthropic provider usage", () => {
  it("aggregates provider-reported costs, cache tokens, models, and categories", async () => {
    const fetchFn = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.pathname.endsWith("/organizations/cost_report")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                starting_at: "2026-07-06T00:00:00Z",
                ending_at: "2026-07-07T00:00:00Z",
                results: [{ amount: "1234", currency: "USD", description: "Claude API" }],
              },
            ],
            has_more: false,
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          data: [
            {
              starting_at: "2026-07-06T00:00:00Z",
              ending_at: "2026-07-07T00:00:00Z",
              results: [
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
              ],
            },
          ],
          has_more: false,
        }),
        { status: 200 },
      );
    });

    const auth = await resolveAnthropicUsageAuth({
      config: {},
      env: { ANTHROPIC_ADMIN_API_KEY: "sk-ant-admin-test" },
      provider: "anthropic",
      resolveApiKeyFromConfigAndStore: () => undefined,
      resolveOAuthToken: async () => null,
    });
    if (!("token" in auth) || !auth.token) {
      throw new Error("expected encoded Anthropic Admin API credentials");
    }
    const result = await fetchAnthropicUsage({
      config: {},
      env: {},
      provider: "anthropic",
      token: auth.token,
      timeoutMs: 5_000,
      fetchFn: fetchFn as typeof fetch,
    });

    expect(result).toEqual({
      provider: "anthropic",
      displayName: "Anthropic",
      windows: [],
      plan: "Admin API",
      billing: [
        {
          type: "spend",
          label: "30-day API spend",
          amount: 12.34,
          unit: "USD",
          period: "30d",
        },
      ],
      costHistory: {
        unit: "USD",
        periodDays: 30,
        daily: [
          {
            date: "2026-07-06",
            amount: 12.34,
            inputTokens: 1_000,
            cacheWriteTokens: 150,
            cacheReadTokens: 300,
            outputTokens: 250,
            totalTokens: 1_700,
          },
        ],
        models: [
          {
            name: "claude-opus-4-8",
            inputTokens: 1_000,
            cacheReadTokens: 300,
            cacheWriteTokens: 150,
            outputTokens: 250,
            totalTokens: 1_700,
          },
        ],
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

  it.each([{ name: "setup tokens", key: `sk-ant-oat01-${"a".repeat(80)}`, accepted: true }])(
    "classifies $name through the real usage auth owner",
    async ({ key, accepted }) => {
      const result = await resolveAnthropicUsageAuth({
        config: {},
        env: {},
        provider: "anthropic",
        resolveApiKeyFromConfigAndStore: () => undefined,
        resolveApiKeyCandidatesFromConfigAndStore: async () => [key],
        resolveOAuthToken: async () => null,
      });
      expect(result).toEqual(accepted ? { token: key } : { handled: true });
    },
  );

  it("auto-detects an Admin API key stored in the Anthropic provider profile", async () => {
    const result = await resolveAnthropicUsageAuth({
      config: {},
      env: {},
      provider: "anthropic",
      resolveApiKeyFromConfigAndStore: () => undefined,
      resolveApiKeyCandidatesFromConfigAndStore: async () => ["sk-ant-admin-profile"],
      resolveOAuthToken: async () => null,
    });
    expect(result).toEqual({
      token: 'openclaw:anthropic-admin:v1:{"token":"sk-ant-admin-profile"}',
    });
  });

  it("prefers a stored Admin API key when normal API and OAuth credentials coexist", async () => {
    const result = await resolveAnthropicUsageAuth({
      config: {},
      env: {},
      provider: "anthropic",
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
  });

  it("does not refresh the native Claude login for usage polling", async () => {
    const resolveOAuthToken = vi.fn(async () => null);
    const result = await resolveAnthropicUsageAuth({
      config: {},
      env: {},
      provider: "anthropic",
      resolveApiKeyFromConfigAndStore: () => undefined,
      resolveOAuthToken,
    });
    expect(result).toEqual({ handled: true });
    expect(resolveOAuthToken).toHaveBeenCalledOnce();
    expect(resolveOAuthToken).toHaveBeenCalledWith({
      excludeProfileIds: ["anthropic:claude-cli"],
    });
  });

  it("uses plan metadata from the resolved auth profile", async () => {
    const fetchFn = vi.fn(
      async () => new Response(JSON.stringify({ five_hour: { utilization: 10 } }), { status: 200 }),
    );
    const snapshot = await fetchAnthropicUsage({
      config: {},
      env: {},
      provider: "anthropic",
      token: "oauth-token",
      subscriptionType: "pro",
      rateLimitTier: "default_pro",
      timeoutMs: 5000,
      fetchFn,
    });
    expect(snapshot.plan).toBe("Pro");
  });

  it("attaches the resolved credential email to OAuth usage snapshots", async () => {
    const fetchFn = vi.fn(
      async () => new Response(JSON.stringify({ five_hour: { utilization: 10 } }), { status: 200 }),
    );
    const snapshot = await fetchAnthropicUsage({
      config: {},
      env: {},
      provider: "anthropic",
      token: oauthFixtureToken(),
      email: "profile@example.com",
      timeoutMs: 5000,
      fetchFn,
    });
    expect(snapshot.accountEmail).toBe("profile@example.com");
  });

  it("does not attach a plan label when usage has no windows", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }));
    const snapshot = await fetchAnthropicUsage({
      config: {},
      env: {},
      provider: "anthropic",
      token: "oauth-token",
      timeoutMs: 5000,
      fetchFn,
    });
    expect(snapshot.plan).toBeUndefined();
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
