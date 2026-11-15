import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createLazyPromise } from "../../shared/lazy-promise.js";
import type { SourceReplyDeliveryMode } from "../get-reply-options.types.js";
import { resolveAcpTurnText } from "./dispatch-acp-prompt.js";

const loadDispatchAcpParentHistoryRuntime = createLazyPromise(
  () => import("./dispatch-acp-parent-history.runtime.js"),
);

/**
 * Fork (F72): with `acp.seedParentHistory`, an ACP session bound to another chat receives that
 * chat's history the ACP session has not seen. Only the runtime prompt carries it; the
 * child transcript keeps the plain prompt. A failed read falls back to the plain prompt.
 */
export async function resolveAcpParentHistoryTurnText(params: {
  cfg: OpenClawConfig;
  parentSessionKey: string | undefined;
  child: { agentId: string; sessionKey: string; sessionId?: string };
  acpAgent: string;
  prompt: string;
  currentUserEntryId?: string;
  abortSignal?: AbortSignal;
}): Promise<string> {
  if (
    params.cfg.acp?.seedParentHistory !== true ||
    !params.parentSessionKey ||
    params.parentSessionKey === params.child.sessionKey
  ) {
    return params.prompt;
  }
  try {
    const { buildAcpParentHistoryPrompt } = await loadDispatchAcpParentHistoryRuntime();
    return (
      (await buildAcpParentHistoryPrompt({
        ...params,
        parentSessionKey: params.parentSessionKey,
      })) ?? params.prompt
    );
  } catch (error) {
    params.abortSignal?.throwIfAborted();
    logVerbose(`dispatch-acp: parent chat history unavailable: ${formatErrorMessage(error)}`);
    return params.prompt;
  }
}

/** Fork (F72): the ACP runtime turn text, seeded with parent chat history when enabled. */
export async function resolveAcpSeededTurnText(
  dispatch: {
    cfg: OpenClawConfig;
    ctx: { SessionKey?: string };
    abortSignal?: AbortSignal;
    sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
    userTurnTranscriptRecorder?: { getAdmissionReceipt(): { entryId?: string } | undefined };
  },
  prompt: string,
  turn: {
    child: { agentId: string; sessionKey: string; sessionId?: string };
    acpAgent: string;
  },
): Promise<string> {
  const promptText = await resolveAcpParentHistoryTurnText({
    cfg: dispatch.cfg,
    parentSessionKey: normalizeOptionalString(dispatch.ctx.SessionKey),
    child: {
      agentId: turn.child.agentId,
      sessionKey: turn.child.sessionKey,
      sessionId: turn.child.sessionId,
    },
    acpAgent: turn.acpAgent,
    prompt,
    currentUserEntryId: dispatch.userTurnTranscriptRecorder?.getAdmissionReceipt()?.entryId,
    abortSignal: dispatch.abortSignal,
  });
  return resolveAcpTurnText({
    promptText,
    sourceReplyDeliveryMode: dispatch.sourceReplyDeliveryMode,
  });
}
