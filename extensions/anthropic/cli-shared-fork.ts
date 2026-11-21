// Fork: Claude CLI prompt suggestions, Claude in Chrome tools, live process idle time and CLI history
// settings. Kept out of cli-shared.ts so upstream changes there merge without conflicts.
import type {
  CliBackendConfig,
  CliBackendNormalizeConfigContext,
  CliBackendResolveExecutionArgsContext,
} from "openclaw/plugin-sdk/cli-backend";

/** Same flag as cli-shared.ts: runs with restricted tool policies force it. */
const CLAUDE_NO_CHROME_ARG = "--no-chrome";

const CLAUDE_PROMPT_SUGGESTIONS_ARG = "--prompt-suggestions";

/**
 * OPENCLAW_CLAUDE_PROMPT_SUGGESTIONS=0|false turns off Claude Code's next-prompt
 * predictions (on by default). Read on use so config env.vars reloads apply to the next run.
 */
export function isClaudeCliPromptSuggestionsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.OPENCLAW_CLAUDE_PROMPT_SUGGESTIONS?.trim().toLowerCase();
  return value !== "0" && value !== "false";
}

/** Agent turns ask Claude Code to emit a `prompt_suggestion` record after each result. */
export function appendClaudeCliPromptSuggestionArgs(
  args: readonly string[],
  context: Pick<CliBackendResolveExecutionArgsContext, "executionMode">,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const configured = args.some(
    (arg) =>
      arg === CLAUDE_PROMPT_SUGGESTIONS_ARG || arg.startsWith(`${CLAUDE_PROMPT_SUGGESTIONS_ARG}=`),
  );
  return context.executionMode === "side-question" ||
    configured ||
    !isClaudeCliPromptSuggestionsEnabled(env)
    ? [...args]
    : [...args, CLAUDE_PROMPT_SUGGESTIONS_ARG, "true"];
}

/**
 * Fork: Claude Code backs off prompt suggestions after 20 unused ones in a row, and it never learns
 * that a Control UI user took one (Tab + send arrives as a plain message). This env makes it skip
 * that back-off; set only when OpenClaw asks the turn for suggestions.
 */
export function resolveClaudeCliPromptSuggestionEnv(
  context: Pick<CliBackendResolveExecutionArgsContext, "executionMode">,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  return context.executionMode === "side-question" || !isClaudeCliPromptSuggestionsEnabled(env)
    ? {}
    : { CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: "1" };
}

const CLAUDE_CHROME_ARG = "--chrome";

/**
 * Fork: OPENCLAW_CLAUDE_CHROME=1|true gives agent turns Claude Code's Claude in Chrome browser tools
 * (off by default, as upstream). Runs that force `--no-chrome` (restricted tool policies) and side
 * questions stay without it. Read on use so config env.vars reloads apply to the next run.
 */
export function isClaudeCliChromeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes)$/i.test(env.OPENCLAW_CLAUDE_CHROME?.trim() ?? "");
}

export function appendClaudeCliChromeArgs(
  args: readonly string[],
  context: Pick<CliBackendResolveExecutionArgsContext, "executionMode">,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return context.executionMode === "side-question" ||
    args.includes(CLAUDE_CHROME_ARG) ||
    args.includes(CLAUDE_NO_CHROME_ARG) ||
    !isClaudeCliChromeEnabled(env)
    ? [...args]
    : [...args, CLAUDE_CHROME_ARG];
}

/**
 * Fork: `plugins.entries.anthropic.config.liveSessionIdleMinutes` keeps an idle Claude process (and
 * its Claude in Chrome tab group) alive between a chat's turns longer than upstream's 10 minutes.
 */
export function resolveClaudeCliLiveSessionIdle(
  context: CliBackendNormalizeConfigContext | undefined,
): Pick<CliBackendConfig, "liveSessionIdleMs"> {
  const pluginConfig = context?.config?.plugins?.entries?.anthropic?.config;
  const minutes =
    pluginConfig && typeof pluginConfig === "object"
      ? (pluginConfig as { liveSessionIdleMinutes?: unknown }).liveSessionIdleMinutes
      : undefined;
  return typeof minutes === "number" && Number.isSafeInteger(minutes) && minutes >= 1
    ? { liveSessionIdleMs: Math.min(minutes, 1440) * 60_000 }
    : {};
}

/**
 * Fork (F72): `plugins.entries.anthropic.config.cliHistory` opts a single-owner install
 * into history for a CLI-native login and sets how many unseen turns a resumed session gets.
 */
export function resolveClaudeCliHistoryConfig(
  context: CliBackendNormalizeConfigContext | undefined,
): Pick<CliBackendConfig, "historyAllowUnknownAuth" | "maxUnseenTurns"> {
  const pluginConfig = context?.config?.plugins?.entries?.anthropic?.config;
  const history =
    pluginConfig && typeof pluginConfig === "object"
      ? (pluginConfig as { cliHistory?: unknown }).cliHistory
      : undefined;
  if (!history || typeof history !== "object") {
    return {};
  }
  const { allowUnknownAuth, maxUnseenTurns } = history as Record<string, unknown>;
  return {
    ...(allowUnknownAuth === true ? { historyAllowUnknownAuth: true } : {}),
    ...(typeof maxUnseenTurns === "number" &&
    Number.isSafeInteger(maxUnseenTurns) &&
    maxUnseenTurns > 0
      ? { maxUnseenTurns }
      : {}),
  };
}
