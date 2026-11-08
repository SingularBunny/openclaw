import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { notifyListeners, registerListener } from "../shared/listeners.js";

/** Claude Code's prediction of the operator's next prompt for one session. */
export type PromptSuggestionEvent = {
  sessionKey: string;
  agentId?: string;
  runId?: string;
  text: string;
};

// A suggestion is a one-line prompt; anything longer is not worth a ghost hint.
const MAX_PROMPT_SUGGESTION_CHARS = 2_000;
// Latest-per-session memory only; idle sessions keep at most this many entries.
const MAX_PROMPT_SUGGESTION_SESSIONS = 256;

type PromptSuggestionState = {
  latest: Map<string, PromptSuggestionEvent>;
  /** Most recent run started per session; a late suggestion from an older run is stale. */
  currentRuns: Map<string, string>;
  listeners: Set<(evt: PromptSuggestionEvent) => void>;
};

const PROMPT_SUGGESTION_STATE_KEY = Symbol.for("openclaw.promptSuggestionEvents.state");

const state = resolveGlobalSingleton<PromptSuggestionState>(PROMPT_SUGGESTION_STATE_KEY, () => ({
  latest: new Map(),
  currentRuns: new Map(),
  listeners: new Set(),
}));

function remember<T>(map: Map<string, T>, key: string, value: T) {
  map.delete(key);
  map.set(key, value);
  while (map.size > MAX_PROMPT_SUGGESTION_SESSIONS) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    map.delete(oldest);
  }
}

/** Keeps the latest suggestion for the session and notifies listeners; stale runs are dropped. */
export function emitPromptSuggestion(evt: PromptSuggestionEvent): boolean {
  const sessionKey = evt.sessionKey.trim();
  const text = evt.text.trim();
  if (!sessionKey || !text || text.length > MAX_PROMPT_SUGGESTION_CHARS) {
    return false;
  }
  const currentRun = state.currentRuns.get(sessionKey);
  if (currentRun !== undefined && evt.runId !== undefined && currentRun !== evt.runId) {
    return false;
  }
  const event: PromptSuggestionEvent = {
    sessionKey,
    ...(evt.agentId ? { agentId: evt.agentId } : {}),
    ...(evt.runId ? { runId: evt.runId } : {}),
    text,
  };
  remember(state.latest, sessionKey, event);
  notifyListeners(state.listeners, event);
  return true;
}

/** A new run or user message retires the session's suggestion. */
export function clearPromptSuggestion(sessionKey: string, runId?: string): void {
  const key = sessionKey.trim();
  if (!key) {
    return;
  }
  state.latest.delete(key);
  if (runId) {
    remember(state.currentRuns, key, runId);
  }
}

export function getPromptSuggestion(sessionKey: string): PromptSuggestionEvent | undefined {
  return state.latest.get(sessionKey.trim());
}

export function onPromptSuggestion(listener: (evt: PromptSuggestionEvent) => void): () => void {
  return registerListener(state.listeners, listener);
}

export function resetPromptSuggestionEventsForTest(): void {
  state.latest.clear();
  state.currentRuns.clear();
  state.listeners.clear();
}
