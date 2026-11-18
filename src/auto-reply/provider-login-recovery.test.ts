import { describe, expect, it } from "vitest";
import { buildProviderLoginRecovery, CLAUDE_CLI_LOGIN_EXPIRED_HINT } from "./provider-login-recovery.js";

describe("buildProviderLoginRecovery", () => {
  it("tells Claude CLI users to renew the Claude Code login, without a /login button", () => {
    const recovery = buildProviderLoginRecovery({ provider: "claude-cli", oauthReason: "revoked" });
    expect(recovery).toEqual({ hint: CLAUDE_CLI_LOGIN_EXPIRED_HINT });
    expect(recovery?.hint).toContain("`claude auth login`");
    expect(recovery?.hint).not.toContain("/login");
  });

  it("keeps the provider sign-in button for other OAuth providers", () => {
    const recovery = buildProviderLoginRecovery({ provider: "openai", oauthReason: "revoked" });
    expect(recovery?.hint).toContain("/login openai");
    expect(recovery?.presentation?.blocks).toHaveLength(1);
  });

  it("needs OAuth evidence, never the provider name alone", () => {
    expect(buildProviderLoginRecovery({ provider: "claude-cli" })).toBeUndefined();
  });
});
