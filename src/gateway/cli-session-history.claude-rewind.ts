// Rewind points inside Claude's own transcript for rows that chat history merges from it.
import fs from "node:fs";
import readline from "node:readline";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { stripInboundMetadata } from "../auto-reply/reply/strip-inbound-meta.js";
import { resolveClaudeCliSessionFilePathAsync } from "./cli-session-history.claude.js";
import { stripCliPromptDecorations } from "./cli-session-history.prompt-text.js";

const YIELD_LINES = 512;

export type ClaudeCliRewindPoint = {
  /** The native message the rewind cuts before is an operator prompt, not a tool result. */
  prompt: boolean;
  /** Last assistant row before the message on its chain; `--resume-session-at` accepts it. */
  checkpointId?: string;
  /** The prompt text for the composer, without CLI-added context. */
  editorText?: string;
};

type ChainRow = { parent: string | null; type: string; sidechain: boolean };

function readPromptText(content: unknown): string | undefined {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  if (content.some((block) => isRecord(block) && block.type === "tool_result")) {
    return undefined;
  }
  const text = content.flatMap((block) =>
    isRecord(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : [],
  );
  return text.length > 0 ? text.join("\n") : undefined;
}

function decode(line: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(line);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Where a rewind before `messageId` leaves the native Claude session: the last assistant row on
 * the message's parent chain. Claude keeps row uuids when it forks a session, so a row merged
 * from the currently bound session is a valid resume point of that same session.
 */
export async function resolveClaudeCliRewindPoint(params: {
  cliSessionId: string;
  homeDir?: string;
  messageId: string;
}): Promise<ClaudeCliRewindPoint | undefined> {
  const messageId = params.messageId.trim();
  const filePath = messageId ? await resolveClaudeCliSessionFilePathAsync(params) : undefined;
  if (!filePath) {
    return undefined;
  }
  const rows = new Map<string, ChainRow>();
  let target: Record<string, unknown> | undefined;
  const lines = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  let count = 0;
  try {
    for await (const line of lines) {
      if (++count % YIELD_LINES === 0) {
        await yieldToEventLoop();
      }
      // Only rows that name a uuid can be on a chain; skip the parse for the rest.
      if (!line.includes('"uuid":"')) {
        continue;
      }
      const entry = decode(line);
      const uuid = typeof entry?.uuid === "string" ? entry.uuid : undefined;
      if (!entry || !uuid) {
        continue;
      }
      rows.set(uuid, {
        parent: typeof entry.parentUuid === "string" ? entry.parentUuid : null,
        type: typeof entry.type === "string" ? entry.type : "",
        sidechain: entry.isSidechain === true,
      });
      if (uuid === messageId) {
        target = entry;
      }
    }
  } catch {
    return undefined;
  } finally {
    lines.close();
  }
  const own = rows.get(messageId);
  if (!target || !own || own.sidechain) {
    return undefined;
  }
  const message = isRecord(target.message) ? target.message : undefined;
  const rawText = own.type === "user" ? readPromptText(message?.content) : undefined;
  let checkpointId: string | undefined;
  const seen = new Set([messageId]);
  for (let cursor = own.parent; cursor && !seen.has(cursor);) {
    seen.add(cursor);
    const row = rows.get(cursor);
    if (!row) {
      break;
    }
    if (row.type === "assistant" && !row.sidechain) {
      checkpointId = cursor;
      break;
    }
    cursor = row.parent;
  }
  const editorText =
    rawText === undefined ? undefined : stripInboundMetadata(stripCliPromptDecorations(rawText));
  return {
    prompt: rawText !== undefined,
    ...(checkpointId ? { checkpointId } : {}),
    ...(editorText?.trim() ? { editorText: editorText.trim() } : {}),
  };
}
