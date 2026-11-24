// Fork: where an ACP turn asks the user, and where a typed answer is looked for.
import { claimPreparedPendingAgentQuestionAnswer } from "../../agents/harness/gateway-question.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";

/**
 * Where an ACP turn asks the user (permission buttons, elicitation forms). A chat bound to
 * an ACP session (`/acp spawn --bind here`, a picked agent, a bound thread or channel
 * conversation) types into its own session, not the ACP one, and the Control UI docks a
 * question only in the session the question names; so it goes to the conversation the
 * message came from. A turn sent to the ACP session itself asks there.
 */
export function resolveAcpQuestionTarget(params: {
  sourceSessionKey: string | undefined;
  acpSessionKey: string;
  acpAgentId: string;
}): { sessionKey: string; agentId: string } {
  const source = params.sourceSessionKey?.trim();
  const sourceAgentId = parseAgentSessionKey(source)?.agentId;
  // A key that names no agent cannot be matched to its store; keep the ACP session.
  if (
    !source ||
    !sourceAgentId ||
    source.toLowerCase() === params.acpSessionKey.trim().toLowerCase()
  ) {
    return { sessionKey: params.acpSessionKey, agentId: params.acpAgentId };
  }
  return { sessionKey: source, agentId: normalizeAgentId(sourceAgentId) };
}

/**
 * A typed answer claims a question pending in the conversation it was typed in (a bound
 * chat) or in the ACP session. A key with no pending question returns false before any effect.
 */
export async function claimAcpQuestionAnswer(
  params: Omit<Parameters<typeof claimPreparedPendingAgentQuestionAnswer>[0], "sessionKey"> & {
    sessionKeys: ReadonlyArray<string | undefined>;
  },
  assertPreparedCurrent: () => Promise<void>,
): Promise<boolean> {
  const { sessionKeys, ...claim } = params;
  const keys = [...new Set(sessionKeys.map((key) => key?.trim()).filter(Boolean))] as string[];
  for (const sessionKey of keys) {
    if (
      await claimPreparedPendingAgentQuestionAnswer({ ...claim, sessionKey }, assertPreparedCurrent)
    ) {
      return true;
    }
  }
  return false;
}
