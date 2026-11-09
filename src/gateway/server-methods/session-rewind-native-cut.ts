import os from "node:os";
import type {
  SessionsBranchesSwitchParams,
  SessionsRewindParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { cliBackendSupportsSessionFork } from "../../agents/cli-backends.js";
import {
  getCliSessionBinding,
  hashCliSessionResumeCompat,
  type CliSessionResumePoint,
} from "../../config/sessions/cli-session-binding.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveClaudeCliRewindPoint } from "../cli-session-history.claude-rewind.js";

const CLAUDE_CLI_PROVIDER = "claude-cli";
const NATIVE_ONLY_UNAVAILABLE =
  "This message is only in Claude's own history, and this chat can no longer resume that Claude session there.";

/**
 * Chat history merges rows from Claude's own transcript. A cut at such a row (or at a local
 * row whose reply carries no recorded checkpoint) resumes the bound Claude session right
 * before that row; Claude keeps row uuids across forks, so the row is a point of the bound
 * session.
 */
export async function resolveNativeMessageCut(
  params: SessionsBranchesSwitchParams | SessionsRewindParams,
  entry: SessionEntry,
  cliForkProviders: readonly string[],
): Promise<
  | { error: string }
  | {
      cliResumePoint?: CliSessionResumePoint;
      nativeCut?: { editorText?: string; keepLeaf?: boolean };
    }
> {
  if (!("entryId" in params)) {
    return {};
  }
  const entryId = params.entryId.trim();
  const nativeMessageId = params.nativeMessageId?.trim() || undefined;
  const nativeOnly = params.nativeOnly === true;
  if (!nativeMessageId) {
    return nativeOnly ? { error: NATIVE_ONLY_UNAVAILABLE } : {};
  }
  const binding = cliForkProviders.includes(CLAUDE_CLI_PROVIDER)
    ? getCliSessionBinding(entry, CLAUDE_CLI_PROVIDER)
    : undefined;
  const point = binding?.sessionId
    ? await resolveClaudeCliRewindPoint({
        cliSessionId: binding.sessionId,
        homeDir: process.env.HOME || os.homedir(),
        messageId: nativeMessageId,
      })
    : undefined;
  const cliResumePoint =
    binding && point?.checkpointId
      ? {
          provider: CLAUDE_CLI_PROVIDER,
          sessionId: binding.sessionId,
          checkpointId: point.checkpointId,
          compat: hashCliSessionResumeCompat(binding),
        }
      : undefined;
  if (!nativeOnly) {
    // A local row: the native checkpoint only refines where Claude resumes.
    return cliResumePoint ? { cliResumePoint } : {};
  }
  if (!point) {
    return { error: NATIVE_ONLY_UNAVAILABLE };
  }
  if (!point.prompt) {
    return { error: `entry is not a user message: ${nativeMessageId}` };
  }
  return {
    ...(cliResumePoint ? { cliResumePoint } : {}),
    nativeCut: {
      ...(point.editorText ? { editorText: point.editorText } : {}),
      ...(entryId === nativeMessageId ? { keepLeaf: true } : {}),
    },
  };
}

/** Bound native CLI sessions that a message cut can fork at an earlier checkpoint. */
export function resolveCliForkProviders(
  entry: Pick<SessionEntry, "cliSessionBindings">,
  cfg: OpenClawConfig,
): string[] {
  return Object.keys(entry.cliSessionBindings ?? {}).filter((provider) =>
    cliBackendSupportsSessionFork(provider, cfg),
  );
}
