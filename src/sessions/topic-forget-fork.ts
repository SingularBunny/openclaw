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
import {
  resolveSqliteTranscriptReadScope,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import { withPreparedTranscriptCorrection } from "../config/sessions/session-transcript-correction.js";
import { reconcileSessionTranscriptIndexes } from "../config/sessions/session-transcript-reconcile.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("sessions/forget");

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
  /** Forgotten earlier: kept only for the chat's similarity baseline, never a candidate. */
  forgotten?: boolean;
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

function isForgotten(message: Record<string, unknown>): boolean {
  return isExcluded(message) && Boolean(asOptionalRecord(message["__openclaw"])?.forgotten);
}

/**
 * Splits the active branch into user turns; already excluded rows are left out. With
 * `keepForgotten`, rows forgotten earlier still give their text (not their ids) to the turn, and a
 * turn with no other rows comes back as `forgotten: true`.
 */
export function collectForgetTurns(
  entries: readonly SessionEntry[],
  options: { keepForgotten?: boolean } = {},
): ForgetTurn[] {
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
      turns.push(turn.entryIds.length > 0 ? { ...turn, text } : { ...turn, text, forgotten: true });
    }
    current = undefined;
  };
  entries.forEach((entry, index) => {
    if (entry.type !== "message") {
      return;
    }
    const message = asOptionalRecord(entry.message);
    if (!message) {
      return;
    }
    const forgotten = options.keepForgotten === true && isForgotten(message);
    if (isExcluded(message) && !forgotten) {
      return;
    }
    const role = message.role;
    const text = role === "user" || role === "assistant" ? messageText(message).trim() : "";
    if (role === "user") {
      finish();
      current = {
        id: entry.id,
        entryIds: forgotten ? [] : [entry.id],
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
    if (!forgotten) {
      current.entryIds.push(entry.id);
    }
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

/**
 * Candidates in chat order. The baseline (mean and deviation) counts the turns forgotten earlier
 * too: without them every repeated search ticked the next layer of the chat, because the top of
 * the distribution was gone (live 23.11.2026: 15 turns forgotten, the next search ticked 12 new
 * ones, none naming the topic).
 */
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
  turns.forEach(({ text: _text, forgotten, ...turn }, index) => {
    if (!forgotten) {
      out.push(Object.assign(turn, ranked[index]!));
    }
  });
  return out;
}

export type ForgetEmbedder = {
  embedQuery(text: string): Promise<number[]>;
  embedDocuments(texts: string[]): Promise<number[][]>;
};

/**
 * Texts per embedding request. A chat's git history easily holds a thousand commits; one request
 * with all of them made llama.cpp's answer exceed its 16 MB JSON limit (live 23.11.2026, 1071
 * commit messages), and the git section silently vanished. 64 vectors stay far below that.
 */
export const FORGET_EMBED_BATCH = 64;

/** Embeds the texts in consecutive batches, keeping their order. */
export async function embedInBatches(
  embed: (texts: string[]) => Promise<number[][]>,
  texts: readonly string[],
  size = FORGET_EMBED_BATCH,
): Promise<number[][]> {
  const vectors: number[][] = [];
  for (let start = 0; start < texts.length; start += size) {
    vectors.push(...(await embed(texts.slice(start, start + size))));
  }
  return vectors;
}

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
  const turns = collectForgetTurns(entries, { keepForgotten: true });
  if (!turns.some((turn) => !turn.forgotten)) {
    return [];
  }
  const [query, documents] = await Promise.all([
    params.embedder.embedQuery(params.topic),
    params.embedder.embedDocuments(turns.map((turn) => turn.text)),
  ]);
  const scores = documents.map((vector) => cosineSimilarity(query, vector));
  return rankForgetCandidates(turns, scores, params.topic);
}

/**
 * Marks the given rows forgotten in one transcript correction; returns the ids actually changed.
 * One write for all rows, so the Gateway rebuilds the transcript projection once. Rows are found
 * in the transcript events themselves, not through the projection: a transcript above the
 * synchronous rebuild limit (4000 rows) rebuilds it in the background after a rewrite, and an
 * entry looked up through it meanwhile is missing (live 23.11.2026: 4 of 567 marked in 14 minutes
 * when every row was rewritten and looked up on its own).
 */
export async function markEntriesForgotten(params: {
  target: ForgetTarget;
  entryIds: readonly string[];
  topic: string;
  now?: number;
}): Promise<string[]> {
  const wanted = new Set(params.entryIds);
  if (wanted.size === 0) {
    return [];
  }
  const at = params.now ?? Date.now();
  const changed = await withPreparedTranscriptCorrection(params.target, async (transcript) => {
    const events = await transcript.readEvents();
    const marked: string[] = [];
    const replaced = events.map((event) => {
      const row = asOptionalRecord(event);
      const message = asOptionalRecord(row?.message);
      if (
        row?.type !== "message" ||
        typeof row.id !== "string" ||
        !wanted.has(row.id) ||
        !message
      ) {
        return event;
      }
      const meta = asOptionalRecord(message["__openclaw"]);
      if (message.excludeFromContext === true && meta?.forgotten) {
        return event;
      }
      marked.push(row.id);
      // Copies, not in-place edits: readEvents may hand out cached rows.
      const updated = Object.assign({}, message, {
        excludeFromContext: true,
        __openclaw: Object.assign({}, meta, { forgotten: { topic: params.topic, at } }),
      });
      return Object.assign({}, row, { message: updated }) as typeof event;
    });
    if (marked.length > 0) {
      await transcript.replaceEvents(replaced);
    }
    return marked;
  });
  if (changed.length > 0) {
    // Above the synchronous limit (4000 rows) the write only marks the projection for a background
    // rebuild, and the chat cannot be read until it runs; a rebuild scheduled from a worker thread
    // fails ("Agent admission requires its host owner"). Run it here, on the Gateway's main thread.
    const database = toDatabaseOptions(resolveSqliteTranscriptReadScope(params.target));
    try {
      await reconcileSessionTranscriptIndexes({
        ...database,
        preferredSessionId: params.target.sessionId,
      });
    } catch (error) {
      log.warn(
        `forget: transcript projection rebuild deferred: session=${params.target.sessionKey}: ${String(error)}`,
      );
    }
  }
  return changed;
}
