// Fork (F72): a bound ACP session shares the chat it is bound to. Its first prompt carries the
// chat's earlier messages; later prompts carry only what other models added since its last turn.
import {
  loadCliSessionConversationMessages,
  readCliSessionLastMessageAt,
} from "../../agents/cli-runner/session-history-conversation.js";
import {
  buildCliSessionHistoryPrompt,
  resolveAutoCliSessionReseedHistoryChars,
} from "../../agents/cli-runner/session-history.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { readSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";

/** The ACP agent's context window is unknown here; budget as for a 200K-token CLI session. */
const ACP_PARENT_HISTORY_CHARS = resolveAutoCliSessionReseedHistoryChars(200_000);

async function resolveTranscriptTarget(cfg: OpenClawConfig, sessionKey: string, agentId?: string) {
  const owner = agentId ?? resolveAgentIdFromSessionKey(sessionKey);
  const storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId: owner });
  const entry = await readSessionEntryReadOnlyInWorker({ agentId: owner, sessionKey, storePath });
  return entry?.sessionId
    ? { agentId: owner, sessionId: entry.sessionId, sessionKey, storePath }
    : undefined;
}

function isSamePrompt(content: string | undefined, prompt: string): boolean {
  const left = content?.trim() ?? "";
  const right = prompt.trim();
  return Boolean(left && right && (left.includes(right) || right.includes(left)));
}

/**
 * Returns the ACP turn text with the parent chat history prepended, or undefined when there is
 * nothing the ACP session has not seen. The child transcript records the plain prompt.
 */
export async function buildAcpParentHistoryPrompt(params: {
  cfg: OpenClawConfig;
  parentSessionKey: string;
  child: { agentId: string; sessionKey: string; sessionId?: string };
  /** ACP harness agent id (e.g. codex); its own replies in the parent are not resent. */
  acpAgent: string;
  prompt: string;
  currentUserEntryId?: string;
  abortSignal?: AbortSignal;
}): Promise<string | undefined> {
  const parent = await resolveTranscriptTarget(params.cfg, params.parentSessionKey);
  if (!parent) {
    return undefined;
  }
  // The child transcript is the cursor: empty means the first prompt; otherwise its newest
  // row marks what this session has already seen (its own turns are recorded there).
  const childTarget = params.child.sessionId
    ? {
        agentId: params.child.agentId,
        sessionId: params.child.sessionId,
        sessionKey: params.child.sessionKey,
        storePath: resolveSessionStorePathCore(params.cfg.session?.store, {
          agentId: params.child.agentId,
        }),
      }
    : undefined;
  const seenUntil = childTarget
    ? await readCliSessionLastMessageAt({
        sessionTarget: childTarget,
        abortSignal: params.abortSignal,
      })
    : undefined;
  const messages = await loadCliSessionConversationMessages({
    sessionTarget: parent,
    abortSignal: params.abortSignal,
    ...(seenUntil !== undefined
      ? {
          afterMs: seenUntil,
          excludeAssistant: (message) =>
            message.provider === "acp" && message.model === params.acpAgent,
        }
      : {}),
    ...(params.currentUserEntryId ? { excludeEntryIds: new Set([params.currentUserEntryId]) } : {}),
  });
  // The current input may already be in the parent chat under another id.
  const last = messages.at(-1);
  if (last?.role === "user" && isSamePrompt(last.content, params.prompt)) {
    messages.pop();
  }
  if (messages.length === 0) {
    return undefined;
  }
  return buildCliSessionHistoryPrompt({
    messages,
    prompt: params.prompt,
    maxHistoryChars: ACP_PARENT_HISTORY_CHARS,
    currentAuthor: { provider: "acp", model: params.acpAgent },
  });
}
