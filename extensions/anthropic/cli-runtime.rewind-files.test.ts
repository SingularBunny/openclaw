import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  CliBackendExecuteContext,
  CliBackendLiveSessionCapability,
  CliBackendLiveSessionHandle,
} from "openclaw/plugin-sdk/cli-backend";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildAnthropicCliBackend } from "./cli-backend.js";
import { CLAUDE_CLI_INPUT_UUID_FIELD, readClaudeCliRewindFilesResult } from "./cli-rewind-files.js";
import { executeClaudeCli } from "./cli.runtime.js";

// Answers like Claude Code 2.1.302 in stream-json mode: checkpoints are keyed by the uuid of
// the user message, `rewind_files` dry runs list files, and a refused real rewind is a
// control error.
const FIXTURE = String.raw`
import { createInterface } from "node:readline";
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const checkpoints = new Set();
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.type === "control_request" && message.request.subtype === "initialize") {
    send({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: {} } });
  } else if (message.type === "control_request" && message.request.subtype === "rewind_files") {
    const { user_message_id: id, dry_run: dryRun } = message.request;
    const known = checkpoints.has(id);
    if (dryRun || known) {
      send({ type: "control_response", response: { subtype: "success", request_id: message.request_id,
        response: known
          ? (dryRun ? { canRewind: true, filesChanged: ["/work/a.ts", "/work/b.ts"], insertions: 3, deletions: 1 } : { canRewind: true })
          : { canRewind: false, error: "No file checkpoint found for this message." } } });
    } else {
      send({ type: "control_response", response: { subtype: "error", request_id: message.request_id,
        error: "No file checkpoint found for this message." } });
    }
  } else if (message.type === "user") {
    checkpoints.add(message.uuid);
    send({ type: "user", isReplay: true, parent_tool_use_id: null, uuid: message.uuid,
      message: { role: "user", content: message.message.content } });
    send({ type: "result", subtype: "success", is_error: false, session_id: "fixture-session",
      result: JSON.stringify({ inputUuid: message.uuid, checkpointing: process.env.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING ?? null }) });
  }
}
`;

const roots: string[] = [];
const handles = new Set<CliBackendLiveSessionHandle>();

afterEach(async () => {
  for (const handle of handles) {
    handle.close("restart");
    await handle.waitForExit();
  }
  handles.clear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function createLiveSession(): CliBackendLiveSessionCapability {
  let current: CliBackendLiveSessionHandle | undefined;
  return {
    fingerprint: "synthetic-process-policy",
    current: () => current,
    restart: async () => {
      current?.close("restart");
      await current?.waitForExit();
    },
    register: (handle) => {
      current = handle;
      handles.add(handle);
    },
    activate: () => {},
    remove: (handle) => {
      if (current === handle) {
        current = undefined;
      }
    },
  };
}

async function createContext(): Promise<CliBackendExecuteContext> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "openclaw-claude-rewind-")));
  roots.push(root);
  const fixture = path.join(root, "claude.mjs");
  await writeFile(fixture, FIXTURE);
  return {
    command: process.execPath,
    args: [fixture],
    cwd: root,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: root,
      CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: "true",
    },
    prompt: "edit two files",
    systemPrompt: "synthetic operator instructions",
    modelId: "claude-sonnet-4-6",
    useResume: false,
    liveSession: createLiveSession(),
    timeoutMs: 10_000,
    abortSignal: AbortSignal.timeout(10_000),
    requestToolPermission: vi.fn(async () => ({ behavior: "deny" as const, message: "denied" })),
    requestUserInput: vi.fn(async () => ({ status: "cancelled" as const, message: "none" })),
  };
}

async function runTurn(context: CliBackendExecuteContext) {
  const records: Record<string, unknown>[] = [];
  for await (const record of executeClaudeCli(context)) {
    records.push(record);
  }
  const result = records.findLast((record) => record.type === "result");
  return {
    result,
    detail: JSON.parse(String(result?.result)) as { inputUuid: string; checkpointing: string },
  };
}

describe("Claude CLI file rewind (F52)", () => {
  it("enables SDK file checkpointing for agent runs only", () => {
    const backend = buildAnthropicCliBackend();
    const agent = backend.prepareExecution?.({
      workspaceDir: "/tmp/openclaw-claude-cli",
      provider: "claude-cli",
      modelId: "claude-opus-4-7",
    } as never) as { env?: Record<string, string> };
    expect(agent.env).toMatchObject({ CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: "true" });
    const isolated = backend.prepareExecution?.({
      workspaceDir: "/tmp/openclaw-claude-cli",
      provider: "claude-cli",
      modelId: "claude-opus-4-7",
      isolatedCompletionPrompt: "side question",
      isolatedCompletionSystemPrompt: "side system",
    } as never) as { env?: Record<string, string> };
    expect(isolated.env).not.toHaveProperty("CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING");
  });

  it("tags the turn result with the input uuid Claude keys its checkpoint by", async () => {
    const context = await createContext();
    const { result, detail } = await runTurn(context);
    expect(detail.checkpointing).toBe("true");
    expect(result?.[CLAUDE_CLI_INPUT_UUID_FIELD]).toBe(detail.inputUuid);
  });

  it("previews and restores files through the idle live process", async () => {
    const context = await createContext();
    const { detail } = await runTurn(context);
    const handle = context.liveSession?.current();
    expect(handle?.isIdle()).toBe(true);

    await expect(handle?.rewindFiles?.(detail.inputUuid, { dryRun: true })).resolves.toEqual({
      canRewind: true,
      filesChanged: ["/work/a.ts", "/work/b.ts"],
      insertions: 3,
      deletions: 1,
    });
    await expect(handle?.rewindFiles?.(detail.inputUuid, { dryRun: false })).resolves.toEqual({
      canRewind: true,
    });
    await expect(handle?.rewindFiles?.("unknown-message", { dryRun: true })).resolves.toEqual({
      canRewind: false,
      error: "No file checkpoint found for this message.",
    });
    // Claude refuses a real rewind with a control error; its reason is kept.
    await expect(handle?.rewindFiles?.("unknown-message", { dryRun: false })).resolves.toEqual({
      canRewind: false,
      error: "No file checkpoint found for this message.",
    });
  });

  it("does not ask a closed process", async () => {
    const context = await createContext();
    await runTurn(context);
    const handle = context.liveSession?.current();
    handle?.close("restart");
    await handle?.waitForExit();
    await expect(handle?.rewindFiles?.("any", { dryRun: true })).resolves.toBeUndefined();
  });
});

describe("readClaudeCliRewindFilesResult", () => {
  it("keeps only well-formed fields", () => {
    expect(
      readClaudeCliRewindFilesResult({
        canRewind: true,
        filesChanged: ["a.ts", 4, "b.ts"],
        insertions: 2,
        deletions: -1,
        skippedLinks: 0,
      }),
    ).toEqual({ canRewind: true, filesChanged: ["a.ts", "b.ts"], insertions: 2 });
    expect(readClaudeCliRewindFilesResult({ filesChanged: [] })).toEqual({
      canRewind: false,
      error: "Claude CLI sent an unreadable file rewind answer.",
    });
  });
});
