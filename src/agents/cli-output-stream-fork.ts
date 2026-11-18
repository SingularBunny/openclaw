import { readClaudeInitCommands } from "../infra/claude-native-commands.js";
import type { CliJsonlStreamingParserOptions } from "./cli-output-contracts.js";
import { readCliResultInputMessageId, readCliResultRefusal } from "./cli-output-records.js";

// Fork: Claude stream-json records the ai-workbench fork reads beyond upstream's parser.

/**
 * Native forks a prompt prediction after the turn's result; it is not assistant output.
 * Returns true when the record was a prediction and needs no further parsing.
 */
export function consumeClaudePromptSuggestion(
  parsed: Record<string, unknown>,
  params: Pick<CliJsonlStreamingParserOptions, "onPromptSuggestion">,
): boolean {
  if (parsed.type !== "prompt_suggestion") {
    return false;
  }
  if (typeof parsed.suggestion === "string") {
    params.onPromptSuggestion?.(parsed.suggestion);
  }
  return true;
}

/** Hands the init record's native slash commands to the autocomplete sink. */
export function notifyClaudeNativeCommands(
  parsed: Record<string, unknown>,
  params: Pick<CliJsonlStreamingParserOptions, "onNativeCommands">,
): void {
  const nativeCommands = params.onNativeCommands ? readClaudeInitCommands(parsed) : undefined;
  if (nativeCommands) {
    try {
      params.onNativeCommands?.(nativeCommands);
    } catch {
      // Autocomplete hints only; a failed sink must not fail the turn.
    }
  }
}

/** Result fields the fork carries: the input message id and a refusal. */
export function readClaudeResultForkFields(parsed: Record<string, unknown>) {
  return { ...readCliResultInputMessageId(parsed), ...readCliResultRefusal(parsed) };
}
