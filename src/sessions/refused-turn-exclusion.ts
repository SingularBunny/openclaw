// Fork (I14): when the user hands a refused reply off to another model, the refused turn (its
// question, any tool steps and the refused reply) stays in the visible transcript but leaves the
// model context: each row gets `excludeFromContext: true` and `__openclaw.refusalHandoff`. Every
// replay path reads context through iterateSessionContextEntries/buildSessionContext, so the
// Claude CLI reseed, resumed-session unseen turns, the ACP parent-history seed and embedded
// models all skip it. The question is then re-sent as a new turn (prior art: Hermes Agent does
// not keep a refused turn in its history).
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { loadCliSessionEntries } from "../agents/cli-runner/session-history.js";
import type { SessionEntry } from "../agents/sessions/session-manager.js";
import { rewritePreparedTranscriptMessageAtAnchor } from "../config/sessions/session-message-rewrite.js";
import { readActiveTranscriptEntryAnchorAsync } from "../config/sessions/session-transcript-anchor-read.js";
import type { RefusalSignal } from "../shared/refusal-signal.js";

export type RefusedTurnTarget = {
  agentId: string;
  sessionId: string;
  sessionKey: string;
  storePath: string;
};

/**
 * Entry ids of the turn a refused assistant reply ends, oldest first: back to the user message
 * it answered, through tool steps; an earlier finished reply ends the search without a question.
 */
export function selectRefusedTurnEntryIds(
  entries: readonly SessionEntry[],
  messageId: string,
): string[] {
  const index = entries.findIndex((entry) => entry.type === "message" && entry.id === messageId);
  const reply = entries[index];
  if (!reply || reply.type !== "message" || reply.message.role !== "assistant") {
    return [];
  }
  const ids = [reply.id];
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const entry = entries[cursor]!;
    if (entry.type !== "message") {
      continue;
    }
    const { message } = entry;
    if (message.role === "user") {
      ids.push(entry.id);
      break;
    }
    if (message.role === "toolResult") {
      ids.push(entry.id);
      continue;
    }
    if (message.role === "assistant" && message.stopReason === "toolUse") {
      ids.push(entry.id);
      continue;
    }
    break;
  }
  return ids.toReversed();
}

async function readAnchor(target: RefusedTurnTarget, entryId: string, signal?: AbortSignal) {
  const anchor = await readActiveTranscriptEntryAnchorAsync({ ...target, entryId }, signal);
  if (anchor) {
    return anchor;
  }
  const { waitForSessionTranscriptProjection } =
    await import("../config/sessions/session-transcript-reconcile.js");
  await waitForSessionTranscriptProjection(target, signal);
  return await readActiveTranscriptEntryAnchorAsync({ ...target, entryId }, signal);
}

/** Leaves the refused turn ending at `messageId` out of the model context; returns its row ids. */
export async function excludeRefusedTurnFromContext(params: {
  target: RefusedTurnTarget;
  messageId: string;
  signal: RefusalSignal;
  now?: number;
  abortSignal?: AbortSignal;
}): Promise<{ entryIds: string[]; excluded: string[] }> {
  const entries = await loadCliSessionEntries({
    sessionTarget: params.target,
    abortSignal: params.abortSignal,
  });
  const entryIds = selectRefusedTurnEntryIds(entries, params.messageId);
  const at = params.now ?? Date.now();
  const excluded: string[] = [];
  for (const entryId of entryIds) {
    const anchor = await readAnchor(params.target, entryId, params.abortSignal);
    if (!anchor) {
      continue;
    }
    const rewritten = await rewritePreparedTranscriptMessageAtAnchor(anchor, (value) => {
      const message = asOptionalRecord(value);
      if (!message || message.excludeFromContext === true) {
        return undefined;
      }
      return {
        ...message,
        excludeFromContext: true,
        __openclaw: {
          ...asOptionalRecord(message["__openclaw"]),
          refusalHandoff: { signal: params.signal, at },
        },
      };
    });
    if (rewritten) {
      excluded.push(entryId);
    }
  }
  return { entryIds, excluded };
}
