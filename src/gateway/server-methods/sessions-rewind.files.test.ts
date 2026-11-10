import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import { loadTranscriptEvents } from "../../config/sessions/session-accessor.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { sessionRewindHandlers } from "./sessions-rewind.js";
import {
  cfg,
  messageCutContext,
  seedMessageCutSource,
  useMessageCutStorageFixture,
} from "./sessions-rewind.storage.test-support.js";
import type { RespondFn } from "./types.js";

const files = vi.hoisted(() => ({
  restore: vi.fn(),
  preview: vi.fn(),
  actualRestore: undefined as undefined | ((...args: unknown[]) => unknown),
}));

vi.mock("./session-rewind-files.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session-rewind-files.js")>();
  files.actualRestore = actual.restoreFilesForRewind as (...args: unknown[]) => unknown;
  return { ...actual, restoreFilesForRewind: files.restore, previewRewindFiles: files.preview };
});

useMessageCutStorageFixture();
beforeEach(() => {
  files.restore.mockReset();
  files.restore.mockImplementation((...args: unknown[]) => files.actualRestore?.(...args));
});

async function invoke(
  method: "sessions.rewind" | "sessions.rewind.files",
  params: Record<string, unknown>,
) {
  const respond = vi.fn<RespondFn>();
  await expectDefined(
    sessionRewindHandlers[method],
    method,
  )({
    req: { type: "req", id: "rewind-files", method, params },
    params,
    respond,
    context: messageCutContext(),
    client: null,
    isWebchatConnect: () => false,
  });
  return respond;
}

it("rewinds the conversation and reports restored files", async () => {
  await withOpenClawTestState({ label: "rewind-files-restored" }, async (state) => {
    await state.writeConfig(cfg);
    const scope = await seedMessageCutSource();
    files.restore.mockResolvedValueOnce({ count: 2 });
    const respond = await invoke("sessions.rewind", {
      sessionKey: scope.sessionKey,
      entryId: "user-2",
      restoreFiles: true,
    });
    expect(respond).toHaveBeenCalledWith(
      true,
      { editorText: "What did I say?", filesRestored: { count: 2 } },
      undefined,
    );
    expect(files.restore).toHaveBeenCalledWith(
      "rewind",
      expect.objectContaining({ entryId: "user-2", restoreFiles: true }),
      expect.objectContaining({ canonicalKey: scope.sessionKey }),
      scope.sessionKey,
    );
  });
});

it("leaves history untouched when the files cannot be restored", async () => {
  await withOpenClawTestState({ label: "rewind-files-refused" }, async (state) => {
    await state.writeConfig(cfg);
    const scope = await seedMessageCutSource();
    const before = await loadTranscriptEvents(scope);
    // The seeded chat has no Claude CLI session: the real check refuses the restore.
    const respond = await invoke("sessions.rewind", {
      sessionKey: scope.sessionKey,
      entryId: "user-2",
      restoreFiles: true,
    });
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: ErrorCodes.UNAVAILABLE,
        message:
          "Files were not restored: Files can be restored only in Claude Code (claude-cli) chats.",
      }),
    );
    expect(await loadTranscriptEvents(scope)).toEqual(before);
  });
});

it("rewinds exactly as before without the option", async () => {
  await withOpenClawTestState({ label: "rewind-files-off" }, async (state) => {
    await state.writeConfig(cfg);
    const scope = await seedMessageCutSource();
    const respond = await invoke("sessions.rewind", {
      sessionKey: scope.sessionKey,
      entryId: "user-2",
    });
    expect(respond).toHaveBeenCalledWith(true, { editorText: "What did I say?" }, undefined);
    await expect(files.restore.mock.results.at(-1)?.value).resolves.toBeUndefined();
  });
});

it("keeps the preview read-only: it does not accept the restore option", async () => {
  const respond = await invoke("sessions.rewind.files", {
    sessionKey: "agent:main:dashboard:source",
    entryId: "user-2",
    restoreFiles: true,
  });
  expect(respond).toHaveBeenCalledWith(
    false,
    undefined,
    expect.objectContaining({ code: ErrorCodes.INVALID_REQUEST }),
  );
});

it("previews which files a rewind would restore", async () => {
  await withOpenClawTestState({ label: "rewind-files-preview" }, async (state) => {
    await state.writeConfig(cfg);
    const scope = await seedMessageCutSource();
    files.preview.mockResolvedValueOnce({ available: false, reason: "Not a Claude chat." });
    const respond = await invoke("sessions.rewind.files", {
      sessionKey: scope.sessionKey,
      entryId: "user-2",
    });
    expect(respond).toHaveBeenCalledWith(
      true,
      { available: false, reason: "Not a Claude chat." },
      undefined,
    );
  });
});
