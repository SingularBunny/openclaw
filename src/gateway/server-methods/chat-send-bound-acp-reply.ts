import type { ReplyDispatchAssistantTranscript } from "../../auto-reply/get-reply-options.types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

/**
 * Fork (F72): with `acp.seedParentHistory`, a bound ACP session's reply mirrored into this
 * chat is recorded as ACP model output, not a transcript-only gateway row, so the models
 * answering after `/acp close` replay it. The chat still shows one row per reply.
 */
export function resolveBoundAcpReplyAuthor(
  cfg: OpenClawConfig,
  sessionKey: string,
  transcript: ReplyDispatchAssistantTranscript | undefined,
): { runtimeAuthor?: { provider: string; model: string }; refusal?: true } {
  if (!transcript || transcript.sessionKey === sessionKey) {
    return {};
  }
  // Fork (I14): an ACP agent's refusal marks the mirrored reply whether or not it is replayed.
  const refusal = transcript.refusal ? { refusal: true as const } : {};
  if (cfg.acp?.seedParentHistory !== true) {
    return refusal;
  }
  return {
    runtimeAuthor: { provider: "acp", model: transcript.acpAgent ?? transcript.agentId },
    ...refusal,
  };
}
