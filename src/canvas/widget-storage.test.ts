// Persistent per-widget storage: scoping, limits, and lifetime tied to Canvas documents.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  WIDGET_STORAGE_MAX_KEYS,
  WIDGET_STORAGE_TOTAL_MAX_BYTES,
  WIDGET_STORAGE_VALUE_MAX_BYTES,
} from "../../packages/gateway-protocol/src/schema/canvas.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createCanvasDocument, resolveWidgetStorageDir } from "./documents.js";
import {
  copyWidgetStorageForFork,
  deleteWidgetStorageValue,
  getWidgetStorageValue,
  listWidgetStorageKeys,
  setWidgetStorageValue,
} from "./widget-storage.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function createWidget(stateDir: string, options: { retentionScope?: string } = {}) {
  const document = await createCanvasDocument(
    { html: "<p>Counter</p>", cspSandbox: "scripts", ...options },
    { stateDir, maxDocumentsPerScope: 2 },
  );
  return { docId: document.id, scopeKey: "agent:main:main", stateDir };
}

describe("widget storage", () => {
  it("round-trips values, lists sorted keys by prefix, and deletes them", async () => {
    const stateDir = tempDirs.make("openclaw-widget-storage-");
    const target = await createWidget(stateDir);

    expect(await getWidgetStorageValue(target, "count")).toBeNull();
    await setWidgetStorageValue(target, "count", "3");
    await setWidgetStorageValue(target, "todo:2", "b");
    await setWidgetStorageValue(target, "todo:1", "a");
    await setWidgetStorageValue(target, "__proto__", "plain data");

    expect(await getWidgetStorageValue(target, "count")).toBe("3");
    expect(await getWidgetStorageValue(target, "__proto__")).toBe("plain data");
    expect(await listWidgetStorageKeys(target, "todo:")).toEqual(["todo:1", "todo:2"]);
    expect(await deleteWidgetStorageValue(target, "count")).toBe(true);
    expect(await deleteWidgetStorageValue(target, "count")).toBe(false);
    expect(await listWidgetStorageKeys(target)).toEqual(["__proto__", "todo:1", "todo:2"]);
  });

  it("keeps state out of the HTTP-served document directory", async () => {
    const stateDir = tempDirs.make("openclaw-widget-storage-");
    const target = await createWidget(stateDir);
    await setWidgetStorageValue(target, "secret", "value");
    const documentFiles = await readdir(path.join(stateDir, "canvas", "documents", target.docId));
    expect(documentFiles.toSorted()).toEqual(["index.html", "manifest.json"]);
    const [file] = await readdir(path.join(resolveWidgetStorageDir(stateDir), target.docId));
    expect(
      JSON.parse(
        await readFile(path.join(resolveWidgetStorageDir(stateDir), target.docId, file!), "utf8"),
      ),
    ).toEqual({ version: 1, entries: [["secret", "value"]] });
  });

  it("isolates sessions and widgets that share nothing but a key", async () => {
    const stateDir = tempDirs.make("openclaw-widget-storage-");
    const first = await createWidget(stateDir);
    const second = await createWidget(stateDir);
    await setWidgetStorageValue(first, "count", "1");

    expect(await getWidgetStorageValue(second, "count")).toBeNull();
    expect(
      await getWidgetStorageValue({ ...first, scopeKey: "agent:main:other" }, "count"),
    ).toBeNull();
  });

  it("retires storage with its document so a later widget starts empty", async () => {
    const stateDir = tempDirs.make("openclaw-widget-storage-");
    const retentionScope = "session-hash";
    const oldest = await createWidget(stateDir, { retentionScope });
    await setWidgetStorageValue(oldest, "count", "7");
    await createWidget(stateDir, { retentionScope });
    await createWidget(stateDir, { retentionScope });

    await expect(getWidgetStorageValue(oldest, "count")).rejects.toMatchObject({
      code: "unavailable",
    });
    await expect(
      readdir(path.join(resolveWidgetStorageDir(stateDir), oldest.docId)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses unknown documents, non-widget documents, and path-like ids", async () => {
    const stateDir = tempDirs.make("openclaw-widget-storage-");
    const plain = await createCanvasDocument({ html: "<p>Plain</p>" }, { stateDir });
    for (const docId of ["cv_missing", plain.id]) {
      await expect(
        setWidgetStorageValue({ docId, scopeKey: "agent:main:main", stateDir }, "k", "v"),
      ).rejects.toMatchObject({ code: "unavailable" });
    }
    await expect(
      getWidgetStorageValue({ docId: "..", scopeKey: "agent:main:main", stateDir }, "k"),
    ).rejects.toMatchObject({ code: "invalid" });
  });

  it.each(["", "a".repeat(201), "with space", "a/b", "a\\b", "it's", 'say"', "tab\tkey"])(
    "rejects key %j",
    async (key) => {
      const stateDir = tempDirs.make("openclaw-widget-storage-");
      const target = await createWidget(stateDir);
      await expect(setWidgetStorageValue(target, key, "v")).rejects.toMatchObject({
        code: "invalid",
      });
    },
  );

  it("enforces value, total, and key-count limits without partial writes", async () => {
    const stateDir = tempDirs.make("openclaw-widget-storage-");
    const target = await createWidget(stateDir);
    await setWidgetStorageValue(target, "max", "a".repeat(WIDGET_STORAGE_VALUE_MAX_BYTES));
    await expect(
      setWidgetStorageValue(target, "big", "🦀".repeat(WIDGET_STORAGE_VALUE_MAX_BYTES / 4 + 1)),
    ).rejects.toMatchObject({ code: "quota" });

    const chunk = "b".repeat(WIDGET_STORAGE_VALUE_MAX_BYTES);
    const fits = Math.floor(WIDGET_STORAGE_TOTAL_MAX_BYTES / (chunk.length + 8));
    for (let index = 1; index < fits; index += 1) {
      await setWidgetStorageValue(target, `chunk${index}`, chunk);
    }
    await expect(setWidgetStorageValue(target, "overflow", chunk)).rejects.toMatchObject({
      code: "quota",
    });
    expect(await getWidgetStorageValue(target, "overflow")).toBeNull();

    const counted = await createWidget(stateDir);
    for (let index = 0; index < WIDGET_STORAGE_MAX_KEYS; index += 1) {
      await setWidgetStorageValue(counted, `k${index}`, "");
    }
    await expect(setWidgetStorageValue(counted, "one-more", "")).rejects.toMatchObject({
      code: "quota",
    });
  });

  it("serializes concurrent writes to one widget", async () => {
    const stateDir = tempDirs.make("openclaw-widget-storage-");
    const target = await createWidget(stateDir);
    await Promise.all(
      Array.from({ length: 20 }, (_, index) => setWidgetStorageValue(target, `k${index}`, "v")),
    );
    expect(await listWidgetStorageKeys(target)).toHaveLength(20);
  });
});

describe("widget storage fork copy", () => {
  const parent = "agent:main:dashboard:parent";
  const child = "agent:main:dashboard:child";
  const toolResult = (docId: string) => ({
    type: "message",
    message: {
      role: "toolResult",
      content: [{ type: "text", text: JSON.stringify({ kind: "canvas", view: { id: docId } }) }],
    },
  });

  it("copies only documents the copied history renders, then lets them diverge", async () => {
    const stateDir = tempDirs.make("openclaw-widget-storage-");
    const kept = await createWidget(stateDir);
    const later = await createWidget(stateDir);
    const keptParent = { ...kept, scopeKey: parent };
    const laterParent = { ...later, scopeKey: parent };
    await setWidgetStorageValue(keptParent, "count", "3");
    await setWidgetStorageValue(laterParent, "count", "9");
    let historyReads = 0;

    const result = await copyWidgetStorageForFork({
      sourceScopeKey: parent,
      targetScopeKey: child,
      stateDir,
      loadHistory: async () => {
        historyReads += 1;
        // A longer id that merely starts with the later document's id is not a reference.
        return [toolResult(kept.docId), { text: `${later.docId}x` }];
      },
    });

    expect(result).toEqual({ copied: [kept.docId], skipped: [] });
    expect(historyReads).toBe(1);
    const keptChild = { ...kept, scopeKey: child };
    expect(await getWidgetStorageValue(keptChild, "count")).toBe("3");
    expect(await getWidgetStorageValue({ ...later, scopeKey: child }, "count")).toBeNull();
    await setWidgetStorageValue(keptChild, "count", "4");
    expect(await getWidgetStorageValue(keptParent, "count")).toBe("3");
  });

  it("does not read history when the parent stored nothing", async () => {
    const stateDir = tempDirs.make("openclaw-widget-storage-");
    await createWidget(stateDir);
    const result = await copyWidgetStorageForFork({
      sourceScopeKey: parent,
      targetScopeKey: child,
      stateDir,
      loadHistory: async () => {
        throw new Error("history must not be read");
      },
    });
    expect(result).toEqual({ copied: [], skipped: [] });
  });

  it("leaves the child empty when the document already holds the maximum sessions", async () => {
    const stateDir = tempDirs.make("openclaw-widget-storage-");
    const widget = await createWidget(stateDir);
    for (let index = 0; index < 8; index += 1) {
      await setWidgetStorageValue(
        { ...widget, scopeKey: index === 0 ? parent : `agent:main:s${index}` },
        "k",
        "v",
      );
    }

    const result = await copyWidgetStorageForFork({
      sourceScopeKey: parent,
      targetScopeKey: child,
      stateDir,
      loadHistory: async () => [toolResult(widget.docId)],
    });

    expect(result).toEqual({
      copied: [],
      skipped: [{ docId: widget.docId, reason: "widget storage has too many sessions" }],
    });
    expect(await getWidgetStorageValue({ ...widget, scopeKey: child }, "k")).toBeNull();
  });
});
