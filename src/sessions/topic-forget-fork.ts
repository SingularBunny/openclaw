// Fork (N11): forget a topic. The user names a topic; the chat's turns are ranked by how close
// they are to it with the local embedding model memory search uses (no chat model involved);
// the user ticks the turns to forget. Forgotten rows get `excludeFromContext` and
// `__openclaw.forgotten`: they stay in the visible chat but never reach a model again, not even
// through a reset's retained tail, and a compaction summary written over them is replaced by a
// neutral note (packages/agent-core forgotten-fork.ts). The Claude CLI binding is dropped, so the
// next turn starts a fresh native session from the filtered history instead of resuming one that
// still holds the topic.
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { loadCliSessionEntries } from "../agents/cli-runner/session-history.js";
import type { SessionEntry } from "../agents/sessions/session-manager.js";
import { rewritePreparedTranscriptMessageAtAnchor } from "../config/sessions/session-message-rewrite.js";
import { readActiveTranscriptEntryAnchorAsync } from "../config/sessions/session-transcript-anchor-read.js";

export type ForgetTarget = {
  agentId: string;
  sessionId: string;
  sessionKey: string;
  storePath: string;
};

/** One user turn: the question and everything that answered it, up to the next question. */
export type ForgetTurn = {
  id: string;
  entryIds: string[];
  text: string;
  preview: string;
  timestamp?: string;
  /** Before the latest compaction: forgetting it also drops that summary. */
  beforeSummary: boolean;
};

export type ForgetCandidate = Omit<ForgetTurn, "text"> & {
  score: number;
  literal: boolean;
  selected: boolean;
};

const TURN_TEXT_LIMIT = 4_000;
const PREVIEW_LIMIT = 240;

function messageText(message: Record<string, unknown>): string {
  const content = message.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => {
      const record = asOptionalRecord(part);
      return record?.type === "text" && typeof record.text === "string" ? record.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

function isExcluded(message: Record<string, unknown>): boolean {
  return message.excludeFromContext === true;
}

/** Splits the active branch into user turns; already excluded rows are left out. */
export function collectForgetTurns(entries: readonly SessionEntry[]): ForgetTurn[] {
  const boundaryIndex = entries.findLastIndex(
    (entry) => entry.type === "compaction" || entry.type === "reset",
  );
  const summaryIndex = entries[boundaryIndex]?.type === "compaction" ? boundaryIndex : -1;
  const turns: ForgetTurn[] = [];
  let current: (ForgetTurn & { parts: string[] }) | undefined;
  const finish = () => {
    if (current) {
      const text = current.parts.join("\n").slice(0, TURN_TEXT_LIMIT);
      const { parts: _parts, ...turn } = current;
      turns.push({ ...turn, text });
    }
    current = undefined;
  };
  entries.forEach((entry, index) => {
    if (entry.type !== "message") {
      return;
    }
    const message = asOptionalRecord(entry.message);
    if (!message || isExcluded(message)) {
      return;
    }
    const role = message.role;
    const text = role === "user" || role === "assistant" ? messageText(message).trim() : "";
    if (role === "user") {
      finish();
      current = {
        id: entry.id,
        entryIds: [entry.id],
        parts: text ? [text] : [],
        text: "",
        preview: text.replace(/\s+/g, " ").slice(0, PREVIEW_LIMIT),
        ...(typeof entry.timestamp === "string" ? { timestamp: entry.timestamp } : {}),
        beforeSummary: index < summaryIndex,
      };
      return;
    }
    if (!current) {
      return;
    }
    current.entryIds.push(entry.id);
    if (text) {
      current.parts.push(text);
    }
  });
  finish();
  return turns.filter((turn) => turn.text.length > 0);
}

export function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    dot += left[index]! * right[index]!;
    leftNorm += left[index]! * left[index]!;
    rightNorm += right[index]! * right[index]!;
  }
  return leftNorm && rightNorm ? dot / Math.sqrt(leftNorm * rightNorm) : 0;
}

/** Words of the topic long enough to be meaningful on their own (case-insensitive). */
function topicWords(topic: string): string[] {
  return topic
    .toLocaleLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 4);
}

/**
 * Which turns start ticked. No published similarity threshold fits every embedding model (BGE
 * and E5 say to calibrate on one's own data), so nothing is removed without the user's tick and
 * the pre-selection is relative to this chat: a turn at least one standard deviation above the
 * chat's mean similarity, or one that names the topic literally. Own rule, set before any run.
 */
export type Closeness = { score: number; literal: boolean; selected: boolean };

/** The chat-relative pre-selection rule for any list of texts (turns or memory paragraphs). */
export function rankByCloseness(
  texts: readonly string[],
  scores: readonly number[],
  topic: string,
): Closeness[] {
  const count = scores.length;
  const mean = count ? scores.reduce((sum, value) => sum + value, 0) / count : 0;
  const deviation = count
    ? Math.sqrt(scores.reduce((sum, value) => sum + (value - mean) ** 2, 0) / count)
    : 0;
  const words = topicWords(topic);
  return texts.map((text, index) => {
    const score = scores[index] ?? 0;
    const lower = text.toLocaleLowerCase();
    // A stem per word, so "налоги" also matches "налогов" and "taxes" matches "taxed".
    const literal =
      words.length > 0 &&
      words.every((word) => lower.includes(word.slice(0, Math.max(4, word.length - 2))));
    const high = count >= 3 && deviation > 0 && score >= mean + deviation;
    return { score, literal, selected: literal || high };
  });
}

export function rankForgetCandidates(
  turns: readonly ForgetTurn[],
  scores: readonly number[],
  topic: string,
): ForgetCandidate[] {
  const ranked = rankByCloseness(
    turns.map((turn) => turn.text),
    scores,
    topic,
  );
  const out: ForgetCandidate[] = [];
  turns.forEach(({ text: _text, ...turn }, index) => {
    out.push(Object.assign(turn, ranked[index]!));
  });
  return out;
}

export type ForgetEmbedder = {
  embedQuery(text: string): Promise<number[]>;
  embedDocuments(texts: string[]): Promise<number[][]>;
};

/** Turns of the chat ranked against the topic, in chat order. */
export async function findForgetCandidates(params: {
  target: ForgetTarget;
  topic: string;
  embedder: ForgetEmbedder;
  signal?: AbortSignal;
  loadEntries?: typeof loadCliSessionEntries;
}): Promise<ForgetCandidate[]> {
  const entries = await (params.loadEntries ?? loadCliSessionEntries)({
    sessionTarget: params.target,
    abortSignal: params.signal,
  });
  const turns = collectForgetTurns(entries);
  if (turns.length === 0) {
    return [];
  }
  const [query, documents] = await Promise.all([
    params.embedder.embedQuery(params.topic),
    params.embedder.embedDocuments(turns.map((turn) => turn.text)),
  ]);
  const scores = documents.map((vector) => cosineSimilarity(query, vector));
  return rankForgetCandidates(turns, scores, params.topic);
}

/** Marks the given rows forgotten; returns the ids actually changed. */
export async function markEntriesForgotten(params: {
  target: ForgetTarget;
  entryIds: readonly string[];
  topic: string;
  now?: number;
  signal?: AbortSignal;
}): Promise<string[]> {
  const at = params.now ?? Date.now();
  const changed: string[] = [];
  for (const entryId of params.entryIds) {
    const anchor = await readActiveTranscriptEntryAnchorAsync(
      { ...params.target, entryId },
      params.signal,
    );
    if (!anchor) {
      continue;
    }
    const rewritten = await rewritePreparedTranscriptMessageAtAnchor(anchor, (value) => {
      const message = asOptionalRecord(value);
      if (!message) {
        return undefined;
      }
      const meta = asOptionalRecord(message["__openclaw"]);
      if (message.excludeFromContext === true && meta?.forgotten) {
        return undefined;
      }
      return {
        ...message,
        excludeFromContext: true,
        __openclaw: { ...meta, forgotten: { topic: params.topic, at } },
      };
    });
    if (rewritten) {
      changed.push(entryId);
    }
  }
  return changed;
}
