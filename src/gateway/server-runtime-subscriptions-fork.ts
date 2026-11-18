import { onAgentEvent } from "../infra/agent-events.js";
import { clearPromptSuggestion, onPromptSuggestion } from "../infra/prompt-suggestion-events.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import { broadcastGatewayMaintenance } from "./maintenance-mode-gate.js";
import type { GatewayBroadcastFn } from "./server-broadcast-types.js";

/** Session subscribers may hold the bare or the agent-scoped form of an unscoped key. */
function promptSuggestionDeliveryKeys(sessionKey: string, agentId?: string): string[] {
  return agentId && !parseAgentSessionKey(sessionKey)
    ? [`agent:${normalizeAgentId(agentId)}:${sessionKey}`, sessionKey]
    : [sessionKey];
}

/**
 * Fork runtime subscriptions: maintenance mode broadcasts and Claude Code's next-prompt
 * predictions. Returns one unsubscribe for all of them.
 */
export function startForkGatewayEventSubscriptions(broadcast: GatewayBroadcastFn): () => void {
  // Maintenance mode on/off, including its own expiry.
  const unsubscribeMaintenance = broadcastGatewayMaintenance(broadcast);
  // Claude Code's next-prompt prediction is composer presentation only; it is never persisted.
  const unsubscribePromptSuggestions = onPromptSuggestion((evt) => {
    broadcast(
      "chat.prompt_suggestion",
      {
        sessionKey: evt.sessionKey,
        ...(evt.runId ? { runId: evt.runId } : {}),
        text: evt.text,
      },
      {
        sessionKeys: promptSuggestionDeliveryKeys(evt.sessionKey, evt.agentId),
        ...(evt.agentId ? { agentId: evt.agentId } : {}),
        dropIfSlow: true,
      },
    );
  });
  // Any new run on the session, whatever its backend, retires the previous prediction.
  const unsubscribePromptSuggestionRuns = onAgentEvent((evt) => {
    if (evt.stream === "lifecycle" && evt.data?.phase === "start" && evt.sessionKey) {
      clearPromptSuggestion(evt.sessionKey);
    }
  });
  return () => {
    unsubscribePromptSuggestions();
    unsubscribePromptSuggestionRuns();
    unsubscribeMaintenance();
  };
}
