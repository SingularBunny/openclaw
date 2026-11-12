import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { captureFileCheckpoint } from "../../agents/file-checkpoints.js";
import type { TranscriptEvent } from "../../config/sessions/session-accessor.sqlite-contract.js";
import {
  findRewindFilesMessageId,
  findRewindFilesMessageTime,
  previewRewindFiles,
  restoreRewindFiles,
  REWIND_FILES_NO_CHECKPOINT,
  REWIND_FILES_NO_PROCESS,
  REWIND_FILES_NO_MESSAGE,
  REWIND_FILES_NOT_RECORDED,
  type RewindFilesTarget,
} from "./session-rewind-files.js";

function reply(id: string, parentId: string, inputMessageId?: string) {
  return {
    type: "message",
    id,
    parentId,
    message: {
      role: "assistant",
      content: "answer",
      __openclaw: {
        cliResume: {
          provider: "claude-cli",
          sessionId: "claude-session",
          checkpointId: `native-${id}`,
          ...(inputMessageId ? { inputMessageId } : {}),
        },
      },
    },
  };
}

function user(id: string, parentId: string | null) {
  return { type: "message", id, parentId, message: { role: "user", content: id } };
}

const events = [
  { type: "session", id: "s", version: 3 },
  user("user-1", null),
  // A reply recorded before F52 has no input id.
  reply("assistant-1", "user-1"),
  user("user-2", "assistant-1"),
  { type: "message", id: "tool-2", parentId: "user-2", message: { role: "toolResult" } },
  reply("assistant-2", "tool-2", "claude-user-2"),
  user("user-3", "assistant-2"),
] as unknown as TranscriptEvent[];

function target(overrides: Partial<RewindFilesTarget> = {}): RewindFilesTarget {
  return {
    entry: { cliSessionBindings: { "claude-cli": { sessionId: "claude-session" } } },
    loadEvents: async () => events,
    entryId: "user-2",
    agentId: "main",
    sessionKeys: ["agent:main:chat"],
    ...overrides,
  };
}

describe("findRewindFilesMessageId", () => {
  it("takes the input id recorded on the reply to the message", () => {
    expect(findRewindFilesMessageId(events, "user-2")).toBe("claude-user-2");
  });

  it("finds nothing for older replies, unanswered messages, or unknown entries", () => {
    expect(findRewindFilesMessageId(events, "user-1")).toBeUndefined();
    expect(findRewindFilesMessageId(events, "user-3")).toBeUndefined();
    expect(findRewindFilesMessageId(events, "missing")).toBeUndefined();
  });
});

describe("previewRewindFiles", () => {
  it("lists the files Claude would restore", async () => {
    const rewindFiles = vi.fn(async () => ({
      canRewind: true,
      filesChanged: ["/work/a.ts"],
      insertions: 4,
      deletions: 2,
    }));
    await expect(previewRewindFiles(target(), rewindFiles)).resolves.toEqual({
      available: true,
      files: ["/work/a.ts"],
      insertions: 4,
      deletions: 2,
    });
    expect(rewindFiles).toHaveBeenCalledWith(
      { backendId: "claude-cli", agentId: "main", sessionKeys: ["agent:main:chat"] },
      "claude-user-2",
      { dryRun: true },
    );
  });

  it("uses the Claude row id of rows merged from Claude's transcript", async () => {
    const rewindFiles = vi.fn(async () => ({ canRewind: true, filesChanged: [] }));
    const loadEvents = vi.fn(async () => events);
    await previewRewindFiles(
      target({ entryId: "user-3", nativeMessageId: "claude-row", loadEvents }),
      rewindFiles,
    );
    expect(rewindFiles).toHaveBeenCalledWith(expect.anything(), "claude-row", { dryRun: true });
    expect(loadEvents).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "turns recorded before input ids",
      overrides: { entryId: "user-1" },
      reason: REWIND_FILES_NO_CHECKPOINT,
    },
  ])("explains why files cannot be restored for $name", async ({ overrides, reason }) => {
    const rewindFiles = vi.fn();
    await expect(previewRewindFiles(target(overrides), rewindFiles)).resolves.toEqual({
      available: false,
      reason,
    });
    expect(rewindFiles).not.toHaveBeenCalled();
  });

  it("explains a missing live process and Claude's own refusal", async () => {
    await expect(previewRewindFiles(target(), async () => undefined)).resolves.toEqual({
      available: false,
      reason: REWIND_FILES_NO_PROCESS,
    });
    await expect(
      previewRewindFiles(target(), async () => ({
        canRewind: false,
        error: "File rewinding is not enabled.",
      })),
    ).resolves.toEqual({ available: false, reason: "File rewinding is not enabled." });
  });
});

describe("restoreRewindFiles", () => {
  it("restores after a dry run and reports the count", async () => {
    const rewindFiles = vi.fn(async (_owner: unknown, _id: string, { dryRun }) =>
      dryRun
        ? { canRewind: true, filesChanged: ["/work/a.ts", "/work/b.ts"] }
        : { canRewind: true, skippedLinks: 1 },
    );
    await expect(restoreRewindFiles(target(), rewindFiles)).resolves.toEqual({
      ok: true,
      count: 2,
      skipped: 1,
    });
    expect(rewindFiles.mock.calls.map((call) => call[2])).toEqual([
      { dryRun: true },
      { dryRun: false },
    ]);
  });

  it("does not touch files when nothing changed", async () => {
    const rewindFiles = vi.fn(async () => ({ canRewind: true, filesChanged: [] }));
    await expect(restoreRewindFiles(target(), rewindFiles)).resolves.toEqual({
      ok: true,
      count: 0,
    });
    expect(rewindFiles).toHaveBeenCalledTimes(1);
  });

  it("fails with Claude's reason when the real rewind is refused", async () => {
    const rewindFiles = vi.fn(async (_owner: unknown, _id: string, { dryRun }) =>
      dryRun
        ? { canRewind: true, filesChanged: ["/work/a.ts"] }
        : { canRewind: false, error: "Failed to rewind: EACCES" },
    );
    await expect(restoreRewindFiles(target(), rewindFiles)).resolves.toEqual({
      ok: false,
      reason: "Failed to rewind: EACCES",
    });
  });

  it("fails without asking Claude when the message has no checkpoint id", async () => {
    const rewindFiles = vi.fn();
    await expect(restoreRewindFiles(target({ entryId: "user-1" }), rewindFiles)).resolves.toEqual({
      ok: false,
      reason: REWIND_FILES_NO_CHECKPOINT,
    });
    expect(rewindFiles).not.toHaveBeenCalled();
  });
});

describe("rewind files without a Claude CLI session", () => {
  const sentAt = Date.parse("2026-01-02T03:04:05.000Z");
  const timedEvents = [
    { type: "session", id: "s", version: 3 },
    { ...user("user-1", null), timestamp: new Date(sentAt - 60_000).toISOString() },
    {
      ...user("user-2", "user-1"),
      timestamp: new Date(sentAt + 500).toISOString(),
      message: { role: "user", content: "user-2", timestamp: sentAt },
    },
  ] as unknown as TranscriptEvent[];

  async function withCheckpoints(
    run: (params: { file: string; generic: RewindFilesTarget }) => Promise<void>,
  ) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rewind-files-"));
    try {
      let clock = sentAt - 1000;
      const checkpointLog = { path: path.join(dir, "log.jsonl"), now: () => clock };
      const file = path.join(dir, "a.txt");
      // One change before the message and one during its turn.
      for (const content of ["before\n", "during\n"]) {
        const record = await captureFileCheckpoint(checkpointLog, file);
        await fs.writeFile(file, content);
        await record?.();
        clock = sentAt + 100;
      }
      await run({
        file,
        generic: target({
          entry: {},
          loadEvents: async () => timedEvents,
          checkpointLog,
        }),
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }

  it("takes the earlier of the row time and the message time", () => {
    expect(findRewindFilesMessageTime(timedEvents, "user-2")).toBe(sentAt);
    expect(findRewindFilesMessageTime(timedEvents, "missing")).toBeUndefined();
  });

  it("previews and restores from OpenClaw's own checkpoints", async () => {
    await withCheckpoints(async ({ file, generic }) => {
      const rewindFiles = vi.fn();
      await expect(previewRewindFiles(generic, rewindFiles)).resolves.toEqual({
        available: true,
        files: [file],
        insertions: 1,
        deletions: 1,
      });
      await expect(restoreRewindFiles(generic, rewindFiles)).resolves.toEqual({
        ok: true,
        count: 1,
      });
      expect(await fs.readFile(file, "utf8")).toBe("before\n");
      await expect(previewRewindFiles(generic, rewindFiles)).resolves.toEqual({
        available: true,
        files: [],
      });
      expect(rewindFiles).not.toHaveBeenCalled();
    });
  });

  it("explains chats without a log and messages off the current branch", async () => {
    await withCheckpoints(async ({ generic }) => {
      await expect(previewRewindFiles({ ...generic, checkpointLog: undefined })).resolves.toEqual({
        available: false,
        reason: REWIND_FILES_NOT_RECORDED,
      });
      await expect(restoreRewindFiles({ ...generic, entryId: "missing" })).resolves.toEqual({
        ok: false,
        reason: REWIND_FILES_NO_MESSAGE,
      });
    });
  });
});
