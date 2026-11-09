import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { persistedMessageEntryId, readChatThreadMessageIdentity } from "./chat-thread-items.ts";

/** What `sessions.rewind` and `sessions.fork` receive for one visible user message. */
export type ChatMessageCutTarget = {
  entryId: string;
  /** The same message in Claude's own transcript, when chat history merged it from there. */
  nativeMessageId?: string;
  /** The message exists only in Claude's own transcript. */
  nativeOnly?: true;
};

const CLAUDE_CLI = "claude-cli";

export const CHAT_MESSAGE_CUT_UNAVAILABLE =
  "This row comes from Claude's own history and is not a message you sent, so the chat cannot be rewound or forked here.";

function metadata(message: unknown) {
  return asRecord(asRecord(message)?.["__openclaw"]);
}

function role(message: unknown): string {
  const value = asRecord(message)?.role;
  return typeof value === "string" ? value.toLowerCase() : "";
}

function claudeNativeId(message: unknown): string | undefined {
  const meta = metadata(message);
  const id = meta?.externalId;
  return meta?.importedFrom === CLAUDE_CLI && typeof id === "string" && id.trim()
    ? id.trim()
    : undefined;
}

function isImportedRow(message: unknown): boolean {
  return readChatThreadMessageIdentity(message)?.isImported === true;
}

function isLocalUserRow(message: unknown): boolean {
  return (
    role(message) === "user" && !isImportedRow(message) && persistedMessageEntryId(message) !== null
  );
}

/** Tool results that Claude records as user rows are not prompts and cannot be rewound to. */
function isToolResultRow(message: unknown): boolean {
  const content = asRecord(message)?.content;
  return (
    Array.isArray(content) &&
    content.some((block) => {
      const type = asRecord(block)?.type;
      return type === "tool_result" || type === "toolResult";
    })
  );
}

/** Replies recorded since native checkpoints exist already tell the Gateway where Claude resumes. */
function precedingReplyHasCheckpoint(messages: readonly unknown[], index: number): boolean {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const message = messages[cursor];
    if (role(message) !== "assistant") {
      continue;
    }
    return !isImportedRow(message) && asRecord(metadata(message)?.cliResume) !== null;
  }
  return true;
}

/** Whether a user row from chat history can be a rewind or fork point at all. */
export function canCutAtChatMessage(message: unknown): boolean {
  return (
    !isImportedRow(message) ||
    (role(message) === "user" && claudeNativeId(message) !== undefined && !isToolResultRow(message))
  );
}

/**
 * Claude CLI chats show rows merged from Claude's own transcript next to OpenClaw rows. Their
 * ids are Claude uuids, so the cut goes to the next OpenClaw user message (or keeps the whole
 * OpenClaw branch) and the Gateway resumes the Claude session right before the native row.
 * Returns null for rows that cannot be rewound at all.
 */
export function resolveChatMessageCutTarget(
  messages: readonly unknown[],
  entryId: string,
): ChatMessageCutTarget | null {
  const index = messages.findIndex((message) => persistedMessageEntryId(message) === entryId);
  const target = messages[index];
  if (index < 0 || !isImportedRow(target)) {
    if (index < 0) {
      return { entryId };
    }
    const own = claudeNativeId(target);
    // An unmatched Claude copy of this prompt may follow it in the same user turn.
    const twin =
      own ??
      (() => {
        const next = messages[index + 1];
        return role(next) === "user" && isImportedRow(next) && !isToolResultRow(next)
          ? claudeNativeId(next)
          : undefined;
      })();
    return twin && !precedingReplyHasCheckpoint(messages, index)
      ? { entryId, nativeMessageId: twin }
      : { entryId };
  }
  const nativeMessageId = claudeNativeId(target);
  if (!nativeMessageId || !canCutAtChatMessage(target)) {
    return null;
  }
  // An imported copy right after an OpenClaw prompt of the same turn rewinds with that prompt.
  const previous = messages[index - 1];
  if (isLocalUserRow(previous)) {
    const previousId = persistedMessageEntryId(previous)!;
    return precedingReplyHasCheckpoint(messages, index - 1)
      ? { entryId: previousId }
      : { entryId: previousId, nativeMessageId };
  }
  const anchor = messages.slice(index + 1).find(isLocalUserRow);
  return {
    entryId: anchor ? persistedMessageEntryId(anchor)! : nativeMessageId,
    nativeMessageId,
    nativeOnly: true,
  };
}
