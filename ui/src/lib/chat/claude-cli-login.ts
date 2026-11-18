/**
 * Fork: recognises a Claude CLI run that failed because Claude Code's own subscription login
 * expired. Matches the Claude Code error text and the Gateway's hint built from it, never a
 * provider name alone, so other providers' auth failures keep their own copy.
 */
export const CLAUDE_CLI_LOGIN_COMMAND = "claude auth login";

const CLAUDE_CLI_LOGIN_EXPIRED_PATTERNS: readonly RegExp[] = [
  // Gateway hint (src/auto-reply/provider-login-recovery.ts CLAUDE_CLI_LOGIN_EXPIRED_HINT).
  /\bClaude subscription login expired\b/i,
  // Claude Code result text when its OAuth refresh fails.
  /\bOAuth session expired and could not be refreshed\b/i,
  /\bNot logged in\s*·\s*Please run \/login\b/i,
  // CLI runner wrapper around a Claude Code 401 (same shape the Gateway classifies).
  /\bclaude-cli\b[\s\S]+?\b(?:failed to authenticate|401\s+invalid authentication credentials)\b/i,
];

export function isClaudeCliLoginExpiredText(text: string | null | undefined): boolean {
  return text ? CLAUDE_CLI_LOGIN_EXPIRED_PATTERNS.some((pattern) => pattern.test(text)) : false;
}
