// Fork (F47, F52, terminal resume): per-conversation controls of live Claude CLI processes and the
// check for turns another writer appended to the native transcript. Kept out of
// cli-live-session-registry.ts so upstream changes there merge without conflicts.
import fs from "node:fs/promises";
import type { CliBackendRewindFilesResult } from "../../plugins/cli-backend.types.js";
import { sleep } from "../../utils/sleep.js";
import { claudeCliSessionTranscriptPath } from "../command/attempt-execution.helpers.js";
import { forkCliLiveSessionRecord, forkCliLiveSessions } from "./cli-live-session-registry.js";
import type { PreparedCliRunContext } from "./types.js";

const TRANSCRIPT_SETTLE_MS = 250;
const TRANSCRIPT_SETTLE_ATTEMPTS = 8;

/**
 * Fork (F47): asks the live CLI process of a conversation to stop one of its background
 * tasks. Resolves false when no live process of that conversation knows the task.
 */
export async function stopCliLiveSessionTask(
  conversation: { agentId?: string; sessionKeys: readonly string[] },
  taskId: string,
): Promise<boolean> {
  for (const record of forkCliLiveSessions().values()) {
    const { agentId, sessionKey } = record.conversation;
    if (
      !sessionKey ||
      !conversation.sessionKeys.includes(sessionKey) ||
      (conversation.agentId && agentId && conversation.agentId !== agentId) ||
      !record.handle.stopTask
    ) {
      continue;
    }
    if (await record.handle.stopTask(taskId)) {
      return true;
    }
  }
  return false;
}

/**
 * Fork (F52): asks the idle live CLI process of a conversation to restore (or, with
 * `dryRun`, list) files changed since one of its native user messages. Resolves undefined
 * when no idle live process of that conversation can take the request.
 */
export async function rewindCliLiveSessionFiles(
  conversation: { backendId: string; agentId?: string; sessionKeys: readonly string[] },
  userMessageId: string,
  options: { dryRun: boolean },
): Promise<CliBackendRewindFilesResult | undefined> {
  for (const [key, record] of forkCliLiveSessions()) {
    const { agentId, sessionKey } = record.conversation;
    if (
      !key.startsWith(`${conversation.backendId}:`) ||
      !sessionKey ||
      !conversation.sessionKeys.includes(sessionKey) ||
      (conversation.agentId && agentId && conversation.agentId !== agentId) ||
      !record.handle.rewindFiles ||
      !record.handle.isIdle()
    ) {
      continue;
    }
    const result = await record.handle.rewindFiles(userMessageId, options);
    if (result) {
      return result;
    }
  }
  return undefined;
}

async function statTranscriptIdentity(filePath: string): Promise<string | undefined> {
  try {
    const stats = await fs.stat(filePath);
    return [stats.dev, stats.ino, stats.size, stats.mtimeMs].join(":");
  } catch {
    return undefined;
  }
}

/**
 * Remembers the native transcript an idle Claude process last wrote, once its trailing writes
 * settle. Never blocks the turn; a transcript that cannot be located keeps plain reuse.
 */
export async function rememberCliLiveSessionTranscript(
  context: PreparedCliRunContext,
  cliSessionId: string | undefined,
): Promise<void> {
  const record = forkCliLiveSessionRecord(context);
  const filePath =
    context.preparedBackend.backend.liveSession === "claude-stdio"
      ? claudeCliSessionTranscriptPath({
          sessionId: cliSessionId,
          workspaceDir: context.cwd ?? context.workspaceDir,
        })
      : null;
  if (!record || record.owner !== context.preparedBackend || !filePath) {
    return;
  }
  const note = {};
  record.transcriptNote = note;
  record.transcript = undefined;
  let identity = await statTranscriptIdentity(filePath);
  for (let attempt = 0; identity && attempt < TRANSCRIPT_SETTLE_ATTEMPTS; attempt += 1) {
    await sleep(TRANSCRIPT_SETTLE_MS);
    const next = await statTranscriptIdentity(filePath);
    if (next === identity) {
      break;
    }
    identity = next;
  }
  // A later turn or a retired process makes this snapshot stale; plain reuse stays.
  if (
    identity &&
    record.transcriptNote === note &&
    record.handle.isIdle() &&
    !record.cleanupPromise
  ) {
    record.transcript = { path: filePath, identity };
  }
}

/**
 * Whether another writer (a terminal `claude --resume`) appended to the transcript since this
 * idle process finished its turn. The process would answer without those turns.
 */
export async function hasCliLiveSessionTranscriptChanged(
  context: PreparedCliRunContext,
): Promise<boolean> {
  const transcript = forkCliLiveSessionRecord(context)?.transcript;
  if (!transcript) {
    return false;
  }
  const identity = await statTranscriptIdentity(transcript.path);
  return identity !== undefined && identity !== transcript.identity;
}
