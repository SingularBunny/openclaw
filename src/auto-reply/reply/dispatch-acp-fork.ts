import {
  closeAdmittedRunDelegatedAuthority,
  type AdmittedRunContext,
} from "../../agents/admitted-run-context.js";
import {
  runAcpTurnAgentEndHook,
  type AcpTurnAgentEndParams,
} from "../../agents/harness/acp-agent-end.js";
import { logVerbose } from "../../globals.js";
import { drainAgentRunTerminalWrites } from "../../infra/agent-run-terminal-writes.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { ReplyDispatchAssistantTranscript } from "../get-reply-options.types.js";

type AcpTurnTarget = Omit<AcpTurnAgentEndParams, "finalText" | "success" | "error" | "startedAt">;

/** Fork (I14): the agent's own refusal reaches the chat row, so the UI offers a hand-off. */
export function markAcpRefusal(
  transcript: ReplyDispatchAssistantTranscript | undefined,
  stopReason: string | undefined,
): ReplyDispatchAssistantTranscript | undefined {
  return transcript && stopReason === "refusal" ? { ...transcript, refusal: true } : transcript;
}

/**
 * Fork: plugins hear that the bound ACP agent replied, as after an embedded or CLI turn.
 * A turn that failed passes its error message.
 */
export function endAcpTurn(target: AcpTurnTarget, finalText: string, error?: string): void {
  runAcpTurnAgentEndHook(
    error === undefined
      ? { ...target, finalText, success: true }
      : { ...target, finalText, success: false, error },
  );
}

/**
 * The lifecycle end commits asynchronously under this admission, and the chat turn joins it
 * only after dispatch returns. Closing at once refuses that write: a bound chat's row stays
 * mid-run, and its next send reconciles the finished turn as an interrupted one.
 */
export function closeAfterTerminalWrites(context: AdmittedRunContext): void {
  void drainAgentRunTerminalWrites(context.operationalRunInstance)
    .finally(() => closeAdmittedRunDelegatedAuthority(context))
    .catch((error: unknown) => {
      logVerbose(`dispatch-acp: closing turn admission failed: ${formatErrorMessage(error)}`);
    });
}
