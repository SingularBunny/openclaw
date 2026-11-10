// Fork (F52): UI-local rows of the turns a rewind removed. History reloads from the Gateway after
// a rewind, but answered question summaries and the "Done in …" recap live in pane state.
import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { forgetSettledQuestionPrompts } from "../../app/question-prompt.ts";
import { scopedAgentParamsForSession } from "../../lib/sessions/index.ts";
import { uiConversationMatches } from "../../lib/sessions/session-key.ts";
import { rewindChatHistory } from "./chat-history-actions.ts";
import type { ChatRewindChoice } from "./chat-rewind-files.ts";
import type { ChatState } from "./chat-state-contract.ts";
import { persistedMessageEntryId } from "./chat-thread-items.ts";
import { getTranscriptState, type ChatThreadState } from "./components/chat-thread-interactions.ts";

/** When the message a rewind cuts at was sent; null when the row carries no time. */
export function readChatRewindCutTime(
  messages: readonly unknown[],
  entryId: string,
): number | null {
  const message = messages.find((candidate) => persistedMessageEntryId(candidate) === entryId);
  const record = asNullableRecord(message);
  return asFiniteNumber(record?.timestamp) ?? asFiniteNumber(record?.ts) ?? null;
}

/**
 * Captures, before the rewind, which conversation and cut time it removes turns from. `clear`
 * drops the recap of the last turn (a rewind always removes it) and the answered questions of
 * this conversation asked from the cut message on (all of them when the cut time is unknown).
 */
export function captureRewoundTurnLeftovers(
  state: Parameters<typeof uiConversationMatches>[0] &
    Parameters<typeof scopedAgentParamsForSession>[0] &
    Pick<ChatState, "sessionKey" | "chatMessages">,
  entryId: string,
) {
  const sessionKey = state.sessionKey;
  const { agentId } = scopedAgentParamsForSession(state, sessionKey);
  const cutAtMs = readChatRewindCutTime(state.chatMessages, entryId);
  return {
    cutAtMs,
    clear(
      questionState: Parameters<typeof forgetSettledQuestionPrompts>[0],
      transcript: Pick<ChatThreadState, "turnRecapWatch">,
    ): void {
      transcript.turnRecapWatch = null;
      forgetSettledQuestionPrompts(
        questionState,
        (prompt) =>
          uiConversationMatches(state, sessionKey, prompt.sessionKey, prompt.agentId, agentId) &&
          (cutAtMs === null || prompt.createdAtMs >= cutAtMs),
      );
    },
  };
}

/** A pane's rewind: cut the transcript, then clear what the cut turns left in pane state. */
export async function rewindPaneChat(
  state: Parameters<typeof rewindChatHistory>[0] | undefined,
  entryId: string,
  choice: ChatRewindChoice | undefined,
  pane: {
    attachmentReads: Parameters<typeof rewindChatHistory>[2];
    questionState: Parameters<typeof forgetSettledQuestionPrompts>[0];
    presentationId: string;
  },
): Promise<boolean> {
  if (!state) {
    return false;
  }
  const leftovers = captureRewoundTurnLeftovers(state, entryId);
  const result = await rewindChatHistory(state, entryId, pane.attachmentReads, choice, () =>
    leftovers.clear(pane.questionState, getTranscriptState(pane.presentationId)),
  );
  state.requestUpdate?.();
  return Boolean(result);
}
