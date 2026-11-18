import { sliceUtf16Safe, truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  historyAuthorNoteLines,
  resolveHistoryAuthorLabel,
  type HistoryAuthor,
} from "./history-author.js";

// Reseed history prompt rendering; the fork renders assistant turns with their author.

// Reseeding uses a context-derived budget bounded by this floor (see session-history.ts).
export const MAX_CLI_SESSION_RESEED_HISTORY_CHARS = 12 * 1024;
const CLI_SESSION_RESEED_CURRENCY_GUIDANCE =
  "[Recovered history may be stale; verify current and time-sensitive facts before acting.]";

export type CliSessionReseedMessage =
  | { role: "compactionSummary"; summary: string; timestamp?: string }
  | {
      role: "user" | "assistant" | "toolResult";
      content: unknown;
      timestamp?: string;
      toolName?: string;
      isError?: boolean;
      /** Fork: who wrote an assistant turn, for author labels in replayed history. */
      provider?: string;
      model?: string;
    };
export function coerceHistoryText(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .flatMap((block) => {
      if (!block || typeof block !== "object") {
        return [];
      }
      const text = (block as { text?: unknown }).text;
      return typeof text === "string" && text.trim().length > 0 ? [text.trim()] : [];
    })
    .join("\n")
    .trim();
}

function renderHistoryMessage(
  entry: CliSessionReseedMessage,
  currentAuthor?: HistoryAuthor,
): string | undefined {
  const author = resolveHistoryAuthorLabel(entry, currentAuthor);
  const role =
    entry.role === "assistant"
      ? author
        ? `Assistant [${author}]`
        : "Assistant"
      : entry.role === "user"
        ? "User"
        : entry.role === "toolResult"
          ? `Tool result${entry.toolName !== undefined ? ` (${entry.toolName})` : ""}${entry.isError ? " [error]" : ""}`
          : "Compaction summary";
  const text =
    entry.role === "compactionSummary" ? entry.summary.trim() : coerceHistoryText(entry.content);
  if (!text) {
    return undefined;
  }
  const timestamp = entry.timestamp;
  return `${timestamp ? `[${timestamp}] ` : ""}${role}: ${text}`;
}

export function buildCliSessionHistoryPrompt(params: {
  messages: CliSessionReseedMessage[];
  prompt: string;
  maxHistoryChars?: number;
  /** Fork: assistant turns another model or agent wrote are rendered with their author. */
  currentAuthor?: HistoryAuthor;
}): string | undefined {
  const maxHistoryChars = params.maxHistoryChars ?? MAX_CLI_SESSION_RESEED_HISTORY_CHARS;
  const render = (message: CliSessionReseedMessage) =>
    renderHistoryMessage(message, params.currentAuthor);
  const historyBudget = maxHistoryChars - CLI_SESSION_RESEED_CURRENCY_GUIDANCE.length - "\n".length;
  if (historyBudget <= 0) {
    return undefined;
  }

  // Pin the leading compaction summary; tail-slicing the whole transcript would
  // discard it whenever the recent turns exceed the budget.
  const firstEntry = params.messages[0];
  const firstIsCompaction = firstEntry?.role === "compactionSummary";
  const summaryRendered = firstIsCompaction ? render(firstEntry) : undefined;
  const tailMessages = firstIsCompaction ? params.messages.slice(1) : params.messages;

  const tailRaw = tailMessages.map(render).filter(Boolean).join("\n\n").trim();

  const truncationMarker = "[OpenClaw reseed history truncated; older turns dropped]";
  const renderTruncatedTail = (raw: string, budget: number): string => {
    if (budget <= truncationMarker.length + "\n".length) {
      return sliceUtf16Safe(raw, -budget).trimStart();
    }
    const tailBudget = budget - truncationMarker.length - "\n".length;
    return `${truncationMarker}\n${sliceUtf16Safe(raw, -tailBudget).trimStart()}`;
  };
  const renderTruncatedSummaryWithTail = (renderedSummary: string): string => {
    if (historyBudget <= truncationMarker.length + "\n".length) {
      return tailRaw.length > 0
        ? sliceUtf16Safe(tailRaw, -historyBudget).trimStart()
        : truncateUtf16Safe(renderedSummary, historyBudget).trimEnd();
    }
    const tailBudget =
      tailRaw.length > 0 ? Math.min(tailRaw.length, Math.floor(historyBudget / 2)) : 0;
    const separatorBudget = tailBudget > 0 ? 2 : 1;
    const summaryBudget = Math.max(
      0,
      historyBudget - truncationMarker.length - separatorBudget - tailBudget,
    );
    const summaryTruncated = truncateUtf16Safe(renderedSummary, summaryBudget).trimEnd();
    const tailTruncated = tailBudget > 0 ? sliceUtf16Safe(tailRaw, -tailBudget).trimStart() : "";
    return [truncationMarker, summaryTruncated, tailTruncated].filter(Boolean).join("\n");
  };

  let renderedHistory: string;
  if (summaryRendered) {
    if (summaryRendered.length >= historyBudget) {
      // Oversize summaries must still leave room for recent exact turns.
      renderedHistory = renderTruncatedSummaryWithTail(summaryRendered);
    } else if (tailRaw.length === 0) {
      renderedHistory = summaryRendered;
    } else {
      const summaryBlock = `${summaryRendered}\n\n`;
      const remainingBudget = historyBudget - summaryBlock.length;
      if (tailRaw.length <= remainingBudget) {
        renderedHistory = `${summaryBlock}${tailRaw}`;
      } else if (remainingBudget <= truncationMarker.length + "\n".length) {
        // Share the budget with the tail when the truncation marker would not fit.
        renderedHistory = renderTruncatedSummaryWithTail(summaryRendered);
      } else {
        renderedHistory = `${summaryBlock}${renderTruncatedTail(tailRaw, remainingBudget)}`;
      }
    }
  } else {
    renderedHistory =
      tailRaw.length > historyBudget ? renderTruncatedTail(tailRaw, historyBudget) : tailRaw;
  }

  if (!renderedHistory) {
    return undefined;
  }

  return [
    "Continue this conversation using the OpenClaw transcript below as prior session history.",
    "Treat it as authoritative context for this fresh CLI session.",
    ...historyAuthorNoteLines(tailMessages, params.currentAuthor),
    "",
    "<conversation_history>",
    CLI_SESSION_RESEED_CURRENCY_GUIDANCE,
    renderedHistory,
    "</conversation_history>",
    "",
    "<next_user_message>",
    params.prompt,
    "</next_user_message>",
  ].join("\n");
}
