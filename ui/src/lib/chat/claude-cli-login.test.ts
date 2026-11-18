import { describe, expect, it } from "vitest";
import { isClaudeCliLoginExpiredText } from "./claude-cli-login.ts";

describe("isClaudeCliLoginExpiredText", () => {
  it.each([
    "Claude subscription login expired: Claude Code on the Gateway can no longer use your Claude account.",
    "Failed to authenticate: OAuth session expired and could not be refreshed",
    "Not logged in · Please run /login",
    "claude-cli run failed: Failed to authenticate. API Error: 401",
    "claude-cli: 401 Invalid authentication credentials",
  ])("recognises %s", (text) => {
    expect(isClaudeCliLoginExpiredText(text)).toBe(true);
  });

  it.each([
    undefined,
    "",
    "Failed to authenticate (attempt 2): connection reset",
    "Your model provider needs a new login. Send `/login openai` from a private chat.",
    "No provider credential is configured for this model.",
  ])("leaves other failures alone: %s", (text) => {
    expect(isClaudeCliLoginExpiredText(text)).toBe(false);
  });
});
