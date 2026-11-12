import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  captureFileCheckpoint,
  FILE_CHECKPOINT_MAX_BYTES,
  FILE_CHECKPOINT_RETENTION_MS,
  type FileCheckpointLog,
  planFileRewind,
  resolveFileCheckpointLog,
  restoreFileCheckpoints,
} from "./file-checkpoints.js";

const DAY = 24 * 60 * 60 * 1000;

let dir: string;
let clock: number;
let log: FileCheckpointLog;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "file-checkpoints-"));
  clock = 1_000_000_000_000;
  log = { path: path.join(dir, "state", "session.jsonl"), now: () => clock };
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

/** Records the checkpoint, then changes the file the way a tool would. */
async function toolWrite(file: string, content: string | null) {
  const record = await captureFileCheckpoint(log, file);
  if (content === null) {
    await fs.rm(file);
  } else {
    await fs.writeFile(file, content);
  }
  await record?.();
}

async function readLog() {
  const text = await fs.readFile(log.path, "utf8").catch(() => "");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { at: number; path: string });
}

describe("file checkpoints", () => {
  it("restores the content before the earliest change after the message", async () => {
    const file = path.join(dir, "a.txt");
    await fs.writeFile(file, "one\n");
    await toolWrite(file, "two\n");
    clock += 1000;
    const since = clock;
    await toolWrite(file, "three\n");
    clock += 1000;
    await toolWrite(file, "four\nfive\n");

    await expect(planFileRewind(log, since)).resolves.toEqual({
      files: [{ path: file, before: Buffer.from("two\n"), insertions: 1, deletions: 2 }],
      skipped: [],
    });
    await expect(restoreFileCheckpoints(log, since)).resolves.toEqual({
      ok: true,
      count: 1,
      skipped: 0,
    });
    expect(await fs.readFile(file, "utf8")).toBe("two\n");
    // The undone entries are dropped; the earlier one stays for a deeper rewind.
    expect((await readLog()).map((entry) => entry.at)).toEqual([since - 1000]);
    await restoreFileCheckpoints(log, 0);
    expect(await fs.readFile(file, "utf8")).toBe("one\n");
  });

  it("deletes files that did not exist and recreates deleted ones", async () => {
    const created = path.join(dir, "new.txt");
    const removed = path.join(dir, "old.txt");
    await fs.writeFile(removed, "keep me");
    await toolWrite(created, "fresh");
    await toolWrite(removed, null);

    const result = await restoreFileCheckpoints(log, clock);
    expect(result).toEqual({ ok: true, count: 2, skipped: 0 });
    await expect(fs.stat(created)).rejects.toThrow();
    expect(await fs.readFile(removed, "utf8")).toBe("keep me");
    expect(await readLog()).toEqual([]);
  });

  it("lists nothing when no file changed after the message", async () => {
    const file = path.join(dir, "a.txt");
    await toolWrite(file, "x");
    await expect(planFileRewind(log, clock + 1)).resolves.toEqual({ files: [], skipped: [] });
    await expect(restoreFileCheckpoints(log, clock + 1)).resolves.toEqual({
      ok: true,
      count: 0,
      skipped: 0,
    });
    expect(await fs.readFile(file, "utf8")).toBe("x");
  });

  it("does not record a change that failed", async () => {
    const record = await captureFileCheckpoint(log, path.join(dir, "never.txt"));
    expect(record).toBeTypeOf("function");
    expect(await readLog()).toEqual([]);
  });

  it("skips files over 10 MB and reports them at rewind", async () => {
    const big = path.join(dir, "big.bin");
    await fs.writeFile(big, Buffer.alloc(FILE_CHECKPOINT_MAX_BYTES + 1));
    await toolWrite(big, "small");
    const [entry] = await fs.readFile(log.path, "utf8").then((text) => text.split("\n"));
    expect(entry && JSON.parse(entry)).toEqual({ at: clock, path: big, skipped: true });

    await expect(restoreFileCheckpoints(log, clock)).resolves.toEqual({
      ok: true,
      count: 0,
      skipped: 1,
    });
    expect(await fs.readFile(big, "utf8")).toBe("small");
  });

  it("drops entries older than 30 days", async () => {
    const file = path.join(dir, "a.txt");
    await toolWrite(file, "first");
    clock += FILE_CHECKPOINT_RETENTION_MS + DAY;
    await toolWrite(file, "second");

    expect((await readLog()).map((entry) => entry.at)).toEqual([clock]);
    await restoreFileCheckpoints(log, 0);
    expect(await fs.readFile(file, "utf8")).toBe("first");
  });

  it("keeps one log per session under the agent's sessions directory", () => {
    const env = { OPENCLAW_STATE_DIR: path.join(dir, "state") };
    expect(resolveFileCheckpointLog({ agentId: "main", sessionId: "abc", env })?.path).toBe(
      path.join(dir, "state", "agents", "main", "sessions", "file-checkpoints", "abc.jsonl"),
    );
    expect(resolveFileCheckpointLog({ agentId: "main", sessionId: "..", env })).toBeUndefined();
    expect(
      resolveFileCheckpointLog({
        agentId: "main",
        sessionId: "abc",
        sessionKey: "agent:main:dashboard:incognito-x",
        env,
      }),
    ).toBeUndefined();
  });
});
