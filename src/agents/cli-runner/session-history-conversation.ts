// Fork (F72): the chat's conversation text for seeding a bound ACP session, kept apart from the
// CLI reseed paths in session-history.ts.
import { timestampMsToIsoString } from "@openclaw/normalization-core/number-coercion";
import {
  buildSessionContext,
  iterateSessionContextEntries,
} from "../../../packages/agent-core/src/harness/session/session.js";
import {
  annotateInterSessionPromptText,
  normalizeInputProvenance,
} from "../../sessions/input-provenance.js";
import { isTranscriptOnlyOpenClawAssistantMessage } from "../../shared/transcript-only-openclaw-assistant.js";
import {
  coerceHistoryText,
  loadCliSessionEntries,
  type CliSessionHistoryParams,
} from "./session-history.js";

type ConversationMessage = {
  role: string;
  content?: string;
  summary?: string;
  timestamp?: string;
  /** Fork: who wrote an assistant turn, for author labels in replayed history. */
  provider?: string;
  model?: string;
};

/**
 * Fork (F72): the chat's user and assistant text in context order, for seeding a bound
 * runtime (ACP) that cannot read this transcript. Tool output, internal system turns,
 * transcript-only rows and context-excluded rows are left out. With `afterMs`, only rows
 * recorded after that time; without it, a leading compaction summary is kept.
 */
export async function loadCliSessionConversationMessages(
  params: CliSessionHistoryParams & {
    afterMs?: number;
    excludeEntryIds?: ReadonlySet<string>;
    excludeAssistant?: (message: { provider?: unknown; model?: unknown }) => boolean;
  },
): Promise<ConversationMessage[]> {
  const entries = await loadCliSessionEntries(params);
  const result: ConversationMessage[] = [];
  if (params.afterMs === undefined) {
    const summary = buildSessionContext(entries).messages[0];
    if (summary?.role === "compactionSummary" && summary.summary.trim()) {
      result.push({ role: "compactionSummary", summary: summary.summary.trim() });
    }
  }
  for (const { entry } of iterateSessionContextEntries(entries)) {
    if (entry.type !== "message" || params.excludeEntryIds?.has(entry.id)) {
      continue;
    }
    const recordedAt = Date.parse(entry.timestamp);
    if (params.afterMs !== undefined && !(recordedAt > params.afterMs)) {
      continue;
    }
    const { message } = entry;
    if (
      (message.role !== "user" && message.role !== "assistant") ||
      isTranscriptOnlyOpenClawAssistantMessage(message) ||
      (message.role === "assistant" && params.excludeAssistant?.(message))
    ) {
      continue;
    }
    const provenance = normalizeInputProvenance(
      "provenance" in message ? message.provenance : undefined,
    );
    if (message.role === "user" && provenance?.kind === "internal_system") {
      continue;
    }
    const content = annotateInterSessionPromptText(coerceHistoryText(message.content), provenance);
    if (content) {
      result.push({
        role: message.role,
        content,
        timestamp: Number.isFinite(recordedAt) ? timestampMsToIsoString(recordedAt) : undefined,
        ...(message.role === "assistant"
          ? { provider: message.provider, model: message.model }
          : {}),
      });
    }
  }
  return result;
}

/** Fork (F72): when the newest message of this transcript was recorded, if any. */
export async function readCliSessionLastMessageAt(
  params: CliSessionHistoryParams,
): Promise<number | undefined> {
  const entries = await loadCliSessionEntries(params);
  const last = entries.findLast((entry) => entry.type === "message");
  const recordedAt = last ? Date.parse(last.timestamp) : Number.NaN;
  return Number.isFinite(recordedAt) ? recordedAt : undefined;
}
