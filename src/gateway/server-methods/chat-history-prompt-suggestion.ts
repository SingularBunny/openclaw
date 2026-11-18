import { getPromptSuggestion } from "../../infra/prompt-suggestion-events.js";

/**
 * Fork: idle sessions replay the latest next-prompt prediction to a (re)loading client.
 * Returns the history payload field, or nothing while a run is in flight.
 */
export function readPromptSuggestionReplay(
  inFlightRun: unknown,
  canonicalKey: string,
  sessionKey: string,
): { promptSuggestion?: { sessionKey: string; runId?: string; text: string } } {
  const stored = inFlightRun
    ? undefined
    : (getPromptSuggestion(canonicalKey) ?? getPromptSuggestion(sessionKey));
  return stored
    ? {
        promptSuggestion: {
          sessionKey: stored.sessionKey,
          ...(stored.runId ? { runId: stored.runId } : {}),
          text: stored.text,
        },
      }
    : {};
}
