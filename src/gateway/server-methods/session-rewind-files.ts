// Fork (F52): rewind with file restore for Claude CLI chats.
//
// Claude Code keeps a file checkpoint per user message when OpenClaw starts it with SDK file
// checkpointing. Each Claude reply records the native id of the user message that started its
// turn (`cliResume.inputMessageId`); rows merged from Claude's own transcript carry that id
// directly (`nativeMessageId`). The idle live CLI process of the chat answers `rewind_files`.
import { asOptionalRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { rewindCliLiveSessionFiles } from "../../agents/cli-runner/cli-live-session-registry.js";
import {
  getCliSessionBinding,
  readCliSessionResumePoint,
} from "../../config/sessions/cli-session-binding.js";
import type { TranscriptEvent } from "../../config/sessions/session-accessor.sqlite-contract.js";
import { loadSessionTranscriptEvents } from "../../config/sessions/session-transcript-events.js";
import {
  scanSessionTranscriptTree,
  selectSessionTranscriptTreePathNodes,
} from "../../config/sessions/transcript-tree.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { CliBackendRewindFilesResult } from "../../plugins/cli-backend.types.js";

const CLAUDE_CLI = "claude-cli";

export const REWIND_FILES_NOT_CLAUDE =
  "Files can be restored only in Claude Code (claude-cli) chats.";
export const REWIND_FILES_NO_CHECKPOINT =
  "This message was sent before OpenClaw recorded Claude's file checkpoints, so its files cannot be restored.";
export const REWIND_FILES_NO_PROCESS =
  "Claude Code is no longer running for this chat. Files can be restored only while its process is still open after a reply.";

export type RewindFilesPreview =
  | { available: true; files: string[]; insertions?: number; deletions?: number }
  | { available: false; reason: string };

export type RewindFilesTarget = {
  entry: Pick<SessionEntry, "cliSessionBindings" | "cliSessionIds" | "claudeCliSessionId">;
  loadEvents: () => Promise<readonly TranscriptEvent[]>;
  entryId: string;
  nativeMessageId?: string;
  agentId?: string;
  sessionKeys: readonly string[];
};

type RewindFiles = typeof rewindCliLiveSessionFiles;

/** The rewind target of one `sessions.rewind` / `sessions.rewind.files` request. */
export function buildRewindFilesTarget(
  current: {
    entry: RewindFilesTarget["entry"] & { sessionId: string };
    canonicalKey: string;
    agentId: string;
    storePath: string;
  },
  params: { entryId: string; nativeMessageId?: string },
  requestedKey: string,
): RewindFilesTarget {
  return {
    entry: current.entry,
    loadEvents: () =>
      loadSessionTranscriptEvents({
        agentId: current.agentId,
        sessionKey: current.canonicalKey,
        sessionId: current.entry.sessionId,
        storePath: current.storePath,
      }),
    entryId: params.entryId.trim(),
    ...(params.nativeMessageId?.trim() ? { nativeMessageId: params.nativeMessageId.trim() } : {}),
    agentId: current.agentId,
    sessionKeys: [...new Set([requestedKey, current.canonicalKey])],
  };
}

/**
 * The native user message whose checkpoint a rewind before `entryId` restores: the input id
 * recorded on the Claude reply that answered that message on the active path.
 */
export function findRewindFilesMessageId(
  events: readonly TranscriptEvent[],
  entryId: string,
): string | undefined {
  const tree = scanSessionTranscriptTree(events);
  const path = selectSessionTranscriptTreePathNodes(tree, tree.leafId);
  const start = path.findIndex((node) => node.id === entryId);
  if (start < 0) {
    return undefined;
  }
  for (const node of path.slice(start + 1)) {
    const record = asRecord(node.entry);
    const message = asRecord(record?.message);
    if (record?.type !== "message" || !message) {
      continue;
    }
    if (message.role === "user") {
      return undefined;
    }
    if (message.role !== "assistant") {
      continue;
    }
    const point = readCliSessionResumePoint(message);
    if (point?.provider === CLAUDE_CLI && point.inputMessageId) {
      return point.inputMessageId;
    }
  }
  return undefined;
}

async function resolveUserMessageId(
  target: RewindFilesTarget,
): Promise<{ id: string } | { reason: string }> {
  if (!getCliSessionBinding(target.entry, CLAUDE_CLI)?.sessionId) {
    return { reason: REWIND_FILES_NOT_CLAUDE };
  }
  const native = target.nativeMessageId?.trim();
  if (native) {
    return { id: native };
  }
  const id = findRewindFilesMessageId(await target.loadEvents(), target.entryId);
  return id ? { id } : { reason: REWIND_FILES_NO_CHECKPOINT };
}

function failureReason(result: CliBackendRewindFilesResult | undefined): string {
  if (!result) {
    return REWIND_FILES_NO_PROCESS;
  }
  return result.error ?? "Claude Code could not restore files for this message.";
}

async function dryRun(
  target: RewindFilesTarget,
  id: string,
  rewindFiles: RewindFiles,
): Promise<RewindFilesPreview> {
  const result = await rewindFiles(
    { backendId: CLAUDE_CLI, agentId: target.agentId, sessionKeys: target.sessionKeys },
    id,
    { dryRun: true },
  );
  if (!result?.canRewind) {
    return { available: false, reason: failureReason(result) };
  }
  return {
    available: true,
    files: result.filesChanged ?? [],
    ...(result.insertions !== undefined ? { insertions: result.insertions } : {}),
    ...(result.deletions !== undefined ? { deletions: result.deletions } : {}),
  };
}

/** `sessions.rewind` with `restoreFiles`: restores before the cut, or explains why not. */
export async function restoreFilesForRewind(
  action: string,
  // Branch switches carry no entry id or option; they never restore files.
  params: object,
  current: {
    entry?: RewindFilesTarget["entry"] & { sessionId?: string };
    canonicalKey: string;
    agentId: string;
    storePath: string;
  },
  requestedKey: string,
  rewindFiles: RewindFiles = rewindCliLiveSessionFiles,
): Promise<{ error: string } | { count: number; skipped?: number } | undefined> {
  const request = params as {
    entryId?: unknown;
    nativeMessageId?: unknown;
    restoreFiles?: unknown;
  };
  if (action !== "rewind" || request.restoreFiles !== true || typeof request.entryId !== "string") {
    return undefined;
  }
  const sessionId = current.entry?.sessionId;
  if (!current.entry || !sessionId) {
    return { error: "Files were not restored: session not found." };
  }
  const restored = await restoreRewindFiles(
    buildRewindFilesTarget(
      { ...current, entry: { ...current.entry, sessionId } },
      {
        entryId: request.entryId,
        ...(typeof request.nativeMessageId === "string"
          ? { nativeMessageId: request.nativeMessageId }
          : {}),
      },
      requestedKey,
    ),
    rewindFiles,
  );
  return restored.ok
    ? { count: restored.count, ...(restored.skipped ? { skipped: restored.skipped } : {}) }
    : { error: `Files were not restored: ${restored.reason}` };
}

/** The `filesRestored` part of the rewind result. */
export function filesRestoredResult(files: Awaited<ReturnType<typeof restoreFilesForRewind>>): {
  filesRestored?: { count: number; skipped?: number };
} {
  return files && !("error" in files) ? { filesRestored: files } : {};
}

/** Asks Claude which files a rewind before the message would restore (dry run). */
export async function previewRewindFiles(
  target: RewindFilesTarget,
  rewindFiles: RewindFiles = rewindCliLiveSessionFiles,
): Promise<RewindFilesPreview> {
  const resolved = await resolveUserMessageId(target);
  return "reason" in resolved
    ? { available: false, reason: resolved.reason }
    : await dryRun(target, resolved.id, rewindFiles);
}

/**
 * Restores the files; the caller rewinds the conversation only when this succeeds. The dry
 * run first gives the count, since Claude's real rewind does not list the files it restored.
 */
export async function restoreRewindFiles(
  target: RewindFilesTarget,
  rewindFiles: RewindFiles = rewindCliLiveSessionFiles,
): Promise<{ ok: true; count: number; skipped?: number } | { ok: false; reason: string }> {
  const resolved = await resolveUserMessageId(target);
  if ("reason" in resolved) {
    return { ok: false, reason: resolved.reason };
  }
  const preview = await dryRun(target, resolved.id, rewindFiles);
  if (!preview.available) {
    return { ok: false, reason: preview.reason };
  }
  if (preview.files.length === 0) {
    return { ok: true, count: 0 };
  }
  const result = await rewindFiles(
    { backendId: CLAUDE_CLI, agentId: target.agentId, sessionKeys: target.sessionKeys },
    resolved.id,
    { dryRun: false },
  );
  if (!result?.canRewind) {
    return { ok: false, reason: failureReason(result) };
  }
  return {
    ok: true,
    count: preview.files.length,
    ...(result.skippedLinks ? { skipped: result.skippedLinks } : {}),
  };
}
