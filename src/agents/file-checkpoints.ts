// Fork (V1): file checkpoints for rewind in any model's chat.
//
// OpenClaw's own file tools (`write`, `edit`, `apply_patch`) record what a file held before they
// changed it, in an append-only log per session. Rewinding to a user message restores, for each
// path, the content recorded by the earliest change made at or after that message. Changes made
// by shell commands (`exec`) or by other processes are not recorded.
import fs from "node:fs/promises";
import path from "node:path";
import { resolveSessionTranscriptsDirForAgent } from "../config/sessions/paths.js";
import { isMissingPathError } from "../infra/errors.js";
import { logWarn } from "../logger.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";

/** Files larger than this are not copied; a rewind reports them as skipped. */
export const FILE_CHECKPOINT_MAX_BYTES = 10 * 1024 * 1024;
/** Same as Claude Code's default `cleanupPeriodDays` (30). */
export const FILE_CHECKPOINT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

export type FileCheckpointLog = {
  /** The session's JSONL log file. */
  path: string;
  now?: () => number;
};

/** One recorded change: `before` is base64 content, or null when the file did not exist. */
type FileCheckpointEntry = { at: number; path: string; before?: string | null; skipped?: true };

export type FileRewindPlan = {
  files: { path: string; before: Buffer | null; insertions: number; deletions: number }[];
  /** Paths whose earlier content was too large to record. */
  skipped: string[];
};

const queues = new Map<string, Promise<unknown>>();
const lastPrunedAt = new Map<string, number>();

function serialize<T>(logPath: string, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(logPath) ?? Promise.resolve();
  const next = previous.then(task, task);
  const settled = next.catch(() => {});
  queues.set(logPath, settled);
  void settled.then(() => {
    if (queues.get(logPath) === settled) {
      queues.delete(logPath);
    }
  });
  return next;
}

/** The checkpoint log of one session; none for incognito chats, which keep nothing on disk. */
export function resolveFileCheckpointLog(params: {
  agentId?: string;
  sessionId?: string;
  sessionKey?: string;
  env?: NodeJS.ProcessEnv;
}): FileCheckpointLog | undefined {
  const agentId = params.agentId?.trim();
  const sessionId = params.sessionId?.trim();
  if (!agentId || !sessionId || isIncognitoSessionKey(params.sessionKey)) {
    return undefined;
  }
  const fileName = encodeURIComponent(sessionId);
  if (fileName === "." || fileName === "..") {
    return undefined;
  }
  return {
    path: path.join(
      resolveSessionTranscriptsDirForAgent(agentId, params.env),
      "file-checkpoints",
      `${fileName}.jsonl`,
    ),
  };
}

/**
 * Reads what the file holds before a tool changes it. The returned callback appends the entry
 * once the change has been written, so failed or refused writes leave no entry.
 */
export async function captureFileCheckpoint(
  log: FileCheckpointLog,
  absolutePath: string,
): Promise<(() => Promise<void>) | undefined> {
  if (!path.isAbsolute(absolutePath)) {
    return undefined;
  }
  const filePath = path.resolve(absolutePath);
  const at = (log.now ?? Date.now)();
  let entry: FileCheckpointEntry;
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      return undefined;
    }
    entry =
      stat.size > FILE_CHECKPOINT_MAX_BYTES
        ? { at, path: filePath, skipped: true }
        : { at, path: filePath, before: (await fs.readFile(filePath)).toString("base64") };
  } catch (error) {
    if (!isMissingPathError(error)) {
      logWarn(`file checkpoint skipped for ${filePath}: ${String(error)}`);
      return undefined;
    }
    entry = { at, path: filePath, before: null };
  }
  return async () => {
    try {
      await appendEntry(log, entry);
    } catch (error) {
      // The file change itself already succeeded; only its rewind is lost.
      logWarn(`file checkpoint not recorded for ${filePath}: ${String(error)}`);
    }
  };
}

function appendEntry(log: FileCheckpointLog, entry: FileCheckpointEntry): Promise<void> {
  return serialize(log.path, async () => {
    await fs.mkdir(path.dirname(log.path), { recursive: true });
    await pruneExpired(log);
    await fs.appendFile(log.path, `${JSON.stringify(entry)}\n`, "utf8");
  });
}

async function readEntries(logPath: string): Promise<FileCheckpointEntry[]> {
  let text: string;
  try {
    text = await fs.readFile(logPath, "utf8");
  } catch (error) {
    if (isMissingPathError(error)) {
      return [];
    }
    throw error;
  }
  const entries: FileCheckpointEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    try {
      const entry = JSON.parse(line) as FileCheckpointEntry;
      if (typeof entry?.at === "number" && typeof entry.path === "string") {
        entries.push(entry);
      }
    } catch {
      // A torn last line from a crash is ignored.
    }
  }
  return entries;
}

async function writeEntries(logPath: string, entries: readonly FileCheckpointEntry[]) {
  if (entries.length === 0) {
    await fs.rm(logPath, { force: true });
    return;
  }
  const temp = `${logPath}.${process.pid}.tmp`;
  await fs.writeFile(temp, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""), "utf8");
  await fs.rename(temp, logPath);
}

/** Drops entries and other sessions' logs older than the retention period (at most hourly). */
async function pruneExpired(log: FileCheckpointLog) {
  const now = (log.now ?? Date.now)();
  if (now - (lastPrunedAt.get(log.path) ?? Number.NEGATIVE_INFINITY) < PRUNE_INTERVAL_MS) {
    return;
  }
  lastPrunedAt.set(log.path, now);
  const cutoff = now - FILE_CHECKPOINT_RETENTION_MS;
  const entries = await readEntries(log.path);
  const kept = entries.filter((entry) => entry.at >= cutoff);
  if (kept.length !== entries.length) {
    await writeEntries(log.path, kept);
  }
  const dir = path.dirname(log.path);
  for (const name of await fs.readdir(dir).catch(() => [] as string[])) {
    const other = path.join(dir, name);
    if (other === log.path || !name.endsWith(".jsonl")) {
      continue;
    }
    const stat = await fs.stat(other).catch(() => undefined);
    if (stat && stat.mtimeMs < cutoff) {
      await fs.rm(other, { force: true }).catch(() => {});
    }
  }
}

async function readCurrent(filePath: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(filePath);
  } catch (error) {
    if (isMissingPathError(error)) {
      return null;
    }
    throw error;
  }
}

function splitLines(content: Buffer | null): string[] {
  if (!content || content.length === 0) {
    return [];
  }
  return content.toString("utf8").replace(/\n$/, "").split("\n");
}

/** Lines the restore adds and removes, counted without regard to order. */
function countLineChanges(current: Buffer | null, restored: Buffer | null) {
  const remaining = new Map<string, number>();
  for (const line of splitLines(current)) {
    remaining.set(line, (remaining.get(line) ?? 0) + 1);
  }
  let insertions = 0;
  for (const line of splitLines(restored)) {
    const count = remaining.get(line) ?? 0;
    if (count > 0) {
      remaining.set(line, count - 1);
    } else {
      insertions += 1;
    }
  }
  let deletions = 0;
  for (const count of remaining.values()) {
    deletions += count;
  }
  return { insertions, deletions };
}

/** What a rewind to `since` would restore: per path, the earliest change at or after it. */
export async function planFileRewind(
  log: FileCheckpointLog,
  since: number,
): Promise<FileRewindPlan> {
  const cutoff = (log.now ?? Date.now)() - FILE_CHECKPOINT_RETENTION_MS;
  const earliest = new Map<string, FileCheckpointEntry>();
  for (const entry of await readEntries(log.path)) {
    if (entry.at < since || entry.at < cutoff) {
      continue;
    }
    const known = earliest.get(entry.path);
    if (!known || entry.at < known.at) {
      earliest.set(entry.path, entry);
    }
  }
  const plan: FileRewindPlan = { files: [], skipped: [] };
  for (const entry of earliest.values()) {
    if (entry.skipped || entry.before === undefined) {
      plan.skipped.push(entry.path);
      continue;
    }
    const before = entry.before === null ? null : Buffer.from(entry.before, "base64");
    const current = await readCurrent(entry.path);
    if (current === null ? before === null : before !== null && current.equals(before)) {
      continue;
    }
    plan.files.push({ path: entry.path, before, ...countLineChanges(current, before) });
  }
  return plan;
}

/**
 * Restores the files of a rewind to `since` and then drops the undone entries. Fails without
 * dropping anything when a file cannot be written.
 */
export async function restoreFileCheckpoints(
  log: FileCheckpointLog,
  since: number,
): Promise<{ ok: true; count: number; skipped: number } | { ok: false; reason: string }> {
  return await serialize(log.path, async () => {
    const plan = await planFileRewind(log, since);
    const failures: string[] = [];
    for (const file of plan.files) {
      try {
        if (file.before === null) {
          await fs.rm(file.path, { force: true });
        } else {
          await fs.mkdir(path.dirname(file.path), { recursive: true });
          await fs.writeFile(file.path, file.before);
        }
      } catch (error) {
        failures.push(`${file.path}: ${String(error)}`);
      }
    }
    if (failures.length > 0) {
      return {
        ok: false,
        reason: `${failures.length} file(s) could not be restored (${failures[0]}).`,
      };
    }
    const entries = await readEntries(log.path);
    const kept = entries.filter((entry) => entry.at < since);
    if (kept.length !== entries.length) {
      await writeEntries(log.path, kept);
    }
    return { ok: true, count: plan.files.length, skipped: plan.skipped.length };
  });
}
