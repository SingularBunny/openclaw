import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { containsAsciiControlCharacter } from "@openclaw/normalization-core/string-normalization";
import {
  WIDGET_STORAGE_KEY_MAX_CHARS,
  WIDGET_STORAGE_MAX_KEYS,
  WIDGET_STORAGE_TOTAL_MAX_BYTES,
  WIDGET_STORAGE_VALUE_MAX_BYTES,
} from "../../packages/gateway-protocol/src/schema/canvas.js";
import { root as fsRoot } from "../infra/fs-safe.js";
import { KeyedAsyncQueue } from "../plugin-sdk/keyed-async-queue.js";
import {
  resolveCanvasDocumentsDir,
  resolveWidgetStorageDir,
  type CanvasDocumentManifest,
} from "./documents.js";

// One document rendered from more sessions (for example a forked transcript)
// gets one namespace per session; this caps how many a single document holds.
const WIDGET_STORAGE_MAX_SCOPES_PER_DOCUMENT = 8;
const STORAGE_FILE_VERSION = 1;
// Keys follow the Claude artifact storage contract so widget code ports unchanged.
const KEY_FORBIDDEN = /[\s/\\'"]/u;

export class WidgetStorageError extends Error {
  constructor(
    readonly code: "invalid" | "unavailable" | "quota",
    message: string,
  ) {
    super(message);
    this.name = "WidgetStorageError";
  }
}

export type WidgetStorageTarget = {
  docId: string;
  /** Canonical session identity; every session gets its own namespace. */
  scopeKey: string;
  stateDir?: string;
};

type StorageFile = { version: number; entries: Array<[string, string]> };

const queue = new KeyedAsyncQueue();

export function assertWidgetStorageKey(key: string): void {
  if (
    key.length === 0 ||
    key.length > WIDGET_STORAGE_KEY_MAX_CHARS ||
    KEY_FORBIDDEN.test(key) ||
    containsAsciiControlCharacter(key)
  ) {
    throw new WidgetStorageError(
      "invalid",
      `widget storage keys must be 1-${WIDGET_STORAGE_KEY_MAX_CHARS} characters without whitespace, slashes, or quotes`,
    );
  }
}

function scopeFileName(scopeKey: string): string {
  return `${createHash("sha256").update(scopeKey).digest("hex")}.json`;
}

async function assertWidgetDocument(target: WidgetStorageTarget): Promise<void> {
  if (!/^[A-Za-z0-9._-]+$/u.test(target.docId) || /^\.{1,2}$/u.test(target.docId)) {
    throw new WidgetStorageError("invalid", "widget document id is invalid");
  }
  try {
    const root = await fsRoot(resolveCanvasDocumentsDir(target.stateDir), { maxBytes: 64 * 1024 });
    const manifest = await root.readJson<Partial<CanvasDocumentManifest>>(
      `${target.docId}/manifest.json`,
    );
    // Only sandboxed show_widget documents run the storage bridge.
    if (manifest.id === target.docId && manifest.cspSandbox === "scripts") {
      return;
    }
  } catch {
    // A retired or unknown document has no storage.
  }
  throw new WidgetStorageError("unavailable", "widget is no longer available");
}

async function readEntries(file: string): Promise<Map<string, string>> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return new Map();
    }
    throw error;
  }
  const parsed = JSON.parse(raw) as Partial<StorageFile>;
  if (parsed.version !== STORAGE_FILE_VERSION || !Array.isArray(parsed.entries)) {
    throw new WidgetStorageError("unavailable", "widget storage is unreadable");
  }
  // Pairs, not an object: keys such as "__proto__" stay ordinary data.
  return new Map(
    parsed.entries.filter(
      (entry): entry is [string, string] =>
        Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1] === "string",
    ),
  );
}

function storedBytes(entries: Map<string, string>): number {
  let total = 0;
  for (const [key, value] of entries) {
    total += Buffer.byteLength(key, "utf8") + Buffer.byteLength(value, "utf8");
  }
  return total;
}

async function writeEntries(
  directory: string,
  file: string,
  entries: Map<string, string>,
): Promise<void> {
  if (entries.size === 0) {
    await fs.rm(file, { force: true });
    return;
  }
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const payload: StorageFile = { version: STORAGE_FILE_VERSION, entries: [...entries] };
  // Write-then-rename keeps a crash from leaving a truncated namespace.
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(payload), { mode: 0o600 });
  await fs.rename(temporary, file);
}

async function withNamespace<T>(
  target: WidgetStorageTarget,
  consume: (namespace: {
    directory: string;
    file: string;
    entries: Map<string, string>;
  }) => Promise<T>,
): Promise<T> {
  const directory = path.join(resolveWidgetStorageDir(target.stateDir), target.docId);
  const file = path.join(directory, scopeFileName(target.scopeKey));
  // Serialize per document so concurrent writes and the namespace cap cannot race.
  return await queue.enqueue(directory, async () => {
    await assertWidgetDocument(target);
    return await consume({ directory, file, entries: await readEntries(file) });
  });
}

export async function getWidgetStorageValue(
  target: WidgetStorageTarget,
  key: string,
): Promise<string | null> {
  assertWidgetStorageKey(key);
  return await withNamespace(target, async ({ entries }) => entries.get(key) ?? null);
}

export async function listWidgetStorageKeys(
  target: WidgetStorageTarget,
  prefix = "",
): Promise<string[]> {
  return await withNamespace(target, async ({ entries }) =>
    [...entries.keys()].filter((key) => key.startsWith(prefix)).toSorted(),
  );
}

export async function setWidgetStorageValue(
  target: WidgetStorageTarget,
  key: string,
  value: string,
): Promise<void> {
  assertWidgetStorageKey(key);
  if (Buffer.byteLength(value, "utf8") > WIDGET_STORAGE_VALUE_MAX_BYTES) {
    throw new WidgetStorageError(
      "quota",
      `widget storage values are limited to ${WIDGET_STORAGE_VALUE_MAX_BYTES} UTF-8 bytes`,
    );
  }
  await withNamespace(target, async ({ directory, file, entries }) => {
    if (entries.size === 0) {
      const existing = await fs.readdir(directory).catch(() => [] as string[]);
      const scopes = existing.filter((name) => name.endsWith(".json"));
      if (scopes.length >= WIDGET_STORAGE_MAX_SCOPES_PER_DOCUMENT) {
        throw new WidgetStorageError("quota", "widget storage has too many sessions");
      }
    }
    entries.set(key, value);
    if (entries.size > WIDGET_STORAGE_MAX_KEYS) {
      throw new WidgetStorageError(
        "quota",
        `widget storage is limited to ${WIDGET_STORAGE_MAX_KEYS} keys`,
      );
    }
    if (storedBytes(entries) > WIDGET_STORAGE_TOTAL_MAX_BYTES) {
      throw new WidgetStorageError(
        "quota",
        `widget storage is limited to ${WIDGET_STORAGE_TOTAL_MAX_BYTES} UTF-8 bytes`,
      );
    }
    await writeEntries(directory, file, entries);
  });
}

export async function deleteWidgetStorageValue(
  target: WidgetStorageTarget,
  key: string,
): Promise<boolean> {
  assertWidgetStorageKey(key);
  return await withNamespace(target, async ({ directory, file, entries }) => {
    if (!entries.delete(key)) {
      return false;
    }
    await writeEntries(directory, file, entries);
    return true;
  });
}

const DOCUMENT_ID_CHAR = /[A-Za-z0-9._-]/u;

/** Whether serialized history names the document as a whole id, not a substring. */
function mentionsDocument(text: string, docId: string): boolean {
  for (let index = text.indexOf(docId); index !== -1; index = text.indexOf(docId, index + 1)) {
    const before = text[index - 1];
    const after = text[index + docId.length];
    if (
      (before === undefined || !DOCUMENT_ID_CHAR.test(before)) &&
      (after === undefined || !DOCUMENT_ID_CHAR.test(after))
    ) {
      return true;
    }
  }
  return false;
}

export type WidgetStorageForkCopyResult = {
  copied: string[];
  skipped: Array<{ docId: string; reason: string }>;
};

/**
 * Seeds a forked session with its parent's widget state. Only documents the
 * copied history still renders are copied; afterwards the namespaces diverge.
 * A document already holding its maximum number of sessions leaves the child
 * empty. History is read only when the parent has stored state at all.
 */
export async function copyWidgetStorageForFork(params: {
  sourceScopeKey: string;
  targetScopeKey: string;
  stateDir?: string;
  loadHistory: () => Promise<readonly unknown[]>;
}): Promise<WidgetStorageForkCopyResult> {
  const result: WidgetStorageForkCopyResult = { copied: [], skipped: [] };
  const sourceName = scopeFileName(params.sourceScopeKey);
  const targetName = scopeFileName(params.targetScopeKey);
  if (sourceName === targetName) {
    return result;
  }
  const storageDir = resolveWidgetStorageDir(params.stateDir);
  const docIds = await fs.readdir(storageDir).catch(() => [] as string[]);
  const candidates: string[] = [];
  for (const docId of docIds.toSorted()) {
    const stat = await fs.stat(path.join(storageDir, docId, sourceName)).catch(() => undefined);
    if (stat?.isFile()) {
      candidates.push(docId);
    }
  }
  if (candidates.length === 0) {
    return result;
  }
  const history = (await params.loadHistory()).map((event) => {
    try {
      return JSON.stringify(event) ?? "";
    } catch {
      return "";
    }
  });
  for (const docId of candidates) {
    if (!history.some((text) => mentionsDocument(text, docId))) {
      continue;
    }
    const directory = path.join(storageDir, docId);
    try {
      // `true` when copied, a reason when skipped, undefined when there is nothing to copy.
      const outcome = await queue.enqueue(
        directory,
        async (): Promise<true | string | undefined> => {
          await assertWidgetDocument({
            docId,
            scopeKey: params.targetScopeKey,
            stateDir: params.stateDir,
          });
          const entries = await readEntries(path.join(directory, sourceName));
          const scopes = (await fs.readdir(directory)).filter((name) => name.endsWith(".json"));
          if (entries.size === 0 || scopes.includes(targetName)) {
            return undefined;
          }
          if (scopes.length >= WIDGET_STORAGE_MAX_SCOPES_PER_DOCUMENT) {
            return "widget storage has too many sessions";
          }
          await writeEntries(directory, path.join(directory, targetName), entries);
          return true;
        },
      );
      if (outcome === true) {
        result.copied.push(docId);
      } else if (outcome) {
        result.skipped.push({ docId, reason: outcome });
      }
    } catch (error) {
      result.skipped.push({
        docId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return result;
}
