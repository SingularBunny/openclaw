import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import type { ErrorCode } from "../../../packages/gateway-protocol/src/schema/error-codes.js";
import { loadSessionTranscriptEvents } from "../../config/sessions/session-transcript-events.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { copyForkedWidgetStorage } from "../widget-storage-fork.js";
import { filesRestoredResult, restoreFilesForRewind } from "./session-rewind-files.js";
import { resolveCliForkProviders, resolveNativeMessageCut } from "./session-rewind-native-cut.js";

type RewindSession = {
  entry: SessionEntry;
  canonicalKey: string;
  agentId: string;
  storePath: string;
};

/**
 * Fork (F52): resolves the Claude CLI part of a message cut before history changes. Files go
 * first; a failed restore leaves history untouched so the operator can retry or rewind the
 * conversation alone. The caller's commit guard still fences the cut.
 */
export async function prepareForkMessageCut(
  action: string,
  params: Parameters<typeof resolveNativeMessageCut>[0],
  current: RewindSession,
  cfg: OpenClawConfig,
  sessionKey: string,
) {
  const cliForkProviders = resolveCliForkProviders(current.entry, cfg);
  const native = await resolveNativeMessageCut(params, current.entry, cliForkProviders);
  if ("error" in native) {
    return { error: native.error } as { error: string; code?: ErrorCode };
  }
  const files = await restoreFilesForRewind(action, params, current, sessionKey);
  if (files && "error" in files) {
    return { error: files.error, code: ErrorCodes.UNAVAILABLE };
  }
  return { cut: { cliForkProviders, ...native }, filesRestored: filesRestoredResult(files) };
}

/** Before the response, so the child's widgets never load an empty state first. */
export async function copyRewindForkWidgets(
  current: RewindSession,
  child: { key: string; entry: { sessionId: string } },
): Promise<void> {
  await copyForkedWidgetStorage({
    source: { sessionKey: current.canonicalKey, agentId: current.agentId },
    target: { sessionKey: child.key, agentId: current.agentId },
    loadHistory: () =>
      loadSessionTranscriptEvents({
        agentId: current.agentId,
        sessionKey: child.key,
        sessionId: child.entry.sessionId,
        storePath: current.storePath,
      }),
  });
}
