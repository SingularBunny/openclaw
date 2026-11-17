// Fork: who actually answered a chat, read from its transcript. Every assistant reply carries the
// provider and model that wrote it (an ACP agent's reply: provider "acp", model "<agent>"), the
// same data the per-reply author badge shows. A failed or stopped turn (a 429, an abort) is not a
// reply, so a model that never answered is never offered as the one to return to.
import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import type { ModelCatalogEntry } from "../../api/types.ts";
import { extractText } from "../../lib/chat/message-extract.ts";
import {
  buildQualifiedChatModelValue,
  resolvePreferredServerChatModelValue,
} from "../../lib/chat/model-ref.ts";
import type { ChatAnswerer } from "./chat-handoff-registry.ts";

const FAILED_STOP_REASONS = new Set(["error", "aborted", "cancelled", "canceled", "timeout"]);

/**
 * The model or ACP agent a stored assistant message names as its author (failed turns too), else
 * undefined (user rows, Gateway rows, messages written before replies carried their author).
 */
export function messageAuthor(
  message: unknown,
  catalog: readonly ModelCatalogEntry[] = [],
): ChatAnswerer | undefined {
  const record = asRecord(message);
  if (record?.role !== "assistant") {
    return undefined;
  }
  // A bound ACP agent's reply that is not replayed stays a gateway row and names its agent in
  // `__openclaw.author` (display only).
  const author = asRecord(asRecord(record["__openclaw"])?.author) ?? record;
  const provider = typeof author.provider === "string" ? author.provider.trim() : "";
  const model = typeof author.model === "string" ? author.model.trim() : "";
  if (!provider || !model || provider === "openclaw" || model === "gateway-injected") {
    return undefined;
  }
  if (provider === "acp") {
    return { kind: "agent", agent: model };
  }
  // The catalog's ref when it lists the model; else the stored pair, so a switch back keeps the
  // provider that served the reply (an unlisted "google/x" stays "openrouter/google/x").
  const resolved = resolvePreferredServerChatModelValue(model, provider, [...catalog]);
  const listed = catalog.some(
    (entry) => `${entry.provider}/${entry.id}`.toLowerCase() === resolved.toLowerCase(),
  );
  return {
    kind: "model",
    model: listed ? resolved : buildQualifiedChatModelValue(model, provider),
  };
}

/** The answerer of a stored assistant message that is a real reply, else undefined. */
export function replyAnswerer(
  message: unknown,
  catalog: readonly ModelCatalogEntry[] = [],
): ChatAnswerer | undefined {
  const record = asRecord(message);
  const stopReason = typeof record?.stopReason === "string" ? record.stopReason : "";
  if (FAILED_STOP_REASONS.has(stopReason) || record?.errorMessage) {
    return undefined;
  }
  if (!extractText(message)?.trim()) {
    return undefined;
  }
  return messageAuthor(message, catalog);
}

function modelIdOf(ref: string): string {
  const slash = ref.indexOf("/");
  return (slash > 0 ? ref.slice(slash + 1) : ref).toLowerCase();
}

/**
 * Same answerer for transcript purposes: one ACP agent, or one model, also when another runtime
 * served it (a CLI runtime records its own provider id for the same model id).
 */
export function sameReplyAuthor(left?: ChatAnswerer | null, right?: ChatAnswerer | null) {
  if (!left || !right || left.kind !== right.kind) {
    return false;
  }
  if (left.kind === "agent") {
    return left.agent === (right as { agent: string }).agent;
  }
  const ids = (ref: string) => [ref.toLowerCase(), modelIdOf(ref)];
  const rightIds = ids((right as { model: string }).model);
  return ids(left.model).some((id) => rightIds.includes(id));
}

/**
 * The last answerer other than `current` that produced a reply in `messages`, newest first.
 * Undefined when nobody else answered in the loaded transcript.
 */
export function lastOtherReplyAnswerer(
  messages: readonly unknown[],
  current: ChatAnswerer | undefined,
  catalog: readonly ModelCatalogEntry[] = [],
): ChatAnswerer | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const answerer = replyAnswerer(messages[index], catalog);
    if (answerer && !sameReplyAuthor(answerer, current)) {
      return answerer;
    }
  }
  return undefined;
}

/** True when some loaded reply names its author, so the transcript can be trusted for "previous". */
export function transcriptNamesAuthors(messages: readonly unknown[]): boolean {
  return messages.some((message) => replyAnswerer(message) !== undefined);
}
