// Fork (F52): file restore through Claude Code's own checkpoints.
//
// Claude Code 2.1.302 keeps file checkpoints in print/SDK mode only when
// CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING is set (the Agent SDK sets it for
// `enableFileCheckpointing`). Each checkpoint is keyed by the uuid of the user
// message that started a turn, which is the `uuid` OpenClaw writes on its stream-json
// input. The `rewind_files` control request restores tracked files to that message's
// checkpoint; `dry_run` only reports the changed files and line counts.
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

export const CLAUDE_CLI_FILE_CHECKPOINTING_ENV = {
  CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: "true",
} as const;

/** The terminal result names the uuid OpenClaw gave the turn's user message. */
export const CLAUDE_CLI_INPUT_UUID_FIELD = "openclaw_input_uuid";

// A real rewind copies backups back; large trees can take a while.
const REWIND_FILES_TIMEOUT_MS = 60_000;

export type ClaudeCliRewindFilesResult = {
  canRewind: boolean;
  error?: string;
  filesChanged?: string[];
  insertions?: number;
  deletions?: number;
  skippedLinks?: number;
};

function readCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** Normalizes the CLI's `rewind_files` response body. */
export function readClaudeCliRewindFilesResult(response: unknown): ClaudeCliRewindFilesResult {
  if (!isRecord(response) || typeof response.canRewind !== "boolean") {
    return { canRewind: false, error: "Claude CLI sent an unreadable file rewind answer." };
  }
  const filesChanged = Array.isArray(response.filesChanged)
    ? response.filesChanged.filter((file): file is string => typeof file === "string")
    : undefined;
  const insertions = readCount(response.insertions);
  const deletions = readCount(response.deletions);
  const skippedLinks = readCount(response.skippedLinks);
  return {
    canRewind: response.canRewind,
    ...(typeof response.error === "string" && response.error.trim()
      ? { error: response.error.trim() }
      : {}),
    ...(filesChanged ? { filesChanged } : {}),
    ...(insertions !== undefined ? { insertions } : {}),
    ...(deletions !== undefined ? { deletions } : {}),
    ...(skippedLinks ? { skippedLinks } : {}),
  };
}

/**
 * Sends `rewind_files` on an idle live process. A real rewind that Claude refuses comes
 * back as a control error; it is reported as `canRewind: false` with Claude's reason.
 */
export async function requestClaudeCliRewindFiles(
  transport: {
    request(request: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>>;
  },
  userMessageId: string,
  dryRun: boolean,
): Promise<ClaudeCliRewindFilesResult> {
  try {
    const response = await transport.request(
      { subtype: "rewind_files", user_message_id: userMessageId, dry_run: dryRun },
      REWIND_FILES_TIMEOUT_MS,
    );
    return readClaudeCliRewindFilesResult(response);
  } catch (error) {
    return {
      canRewind: false,
      error:
        error instanceof Error && error.message ? error.message : "Claude CLI file rewind failed.",
    };
  }
}
