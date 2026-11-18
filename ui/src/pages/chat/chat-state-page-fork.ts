import { scopedAgentParamsForSession } from "../../lib/sessions/navigation.ts";
import { routeChatGroupSend } from "./chat-group.ts";
import {
  canUseChatAcpModels,
  refreshChatAcpModels,
  refreshChatHandoffInfo,
  waitForChatIdle,
} from "./chat-handoff.ts";
import { canReadChatPlanMode, readChatPlanMode, refreshChatPlanMode } from "./chat-plan-mode.ts";
import { handleSendChat } from "./chat-send-submit.ts";
import type { ChatPageHost } from "./chat-state-host.ts";

/**
 * Fork: sends a chat message with the fork's routing around the regular send. A message naming
 * group chat members goes to them (aiwb-groups), not to the chat's answerer; after a send, the
 * handoff binding and plan mode are re-read when the message could have changed them.
 */
export function sendForkChat(
  state: ChatPageHost,
  send: {
    message: string;
    isCommand: boolean;
    messageOverride: Parameters<typeof handleSendChat>[1];
    options: Parameters<typeof handleSendChat>[2];
    submissionAction: Parameters<typeof handleSendChat>[3];
  },
) {
  const { message, isCommand, messageOverride, options } = send;
  const toGroup = isCommand ? undefined : routeChatGroupSend(state, messageOverride, options);
  if (toGroup) {
    return toGroup;
  }
  const sent = handleSendChat(state, messageOverride, options, send.submissionAction);
  // A typed /acp or /session command can bind or unbind the chat; re-read its binding.
  if (isCommand && /^\/(?:acp|session)\b/u.test(message.trim())) {
    void sent.then(async () => {
      await waitForChatIdle(state);
      const info = await refreshChatHandoffInfo(state);
      // A typed `/acp model` changes the bound agent's model; the picker shows it.
      if (info?.binding && canUseChatAcpModels(state)) {
        await refreshChatAcpModels(state);
      }
    });
  }
  // `/plan` and an approved plan change the chat's plan mode; the composer toggle follows.
  const planSessionKey = state.sessionKey;
  const planAgentId = scopedAgentParamsForSession(state, planSessionKey).agentId;
  if (
    canReadChatPlanMode(state) &&
    (/^\/plan\b/u.test(message.trim()) ||
      readChatPlanMode(state, planSessionKey, planAgentId)?.on === true)
  ) {
    void sent.then(async () => {
      await waitForChatIdle(state);
      await refreshChatPlanMode(state, planSessionKey, planAgentId);
    });
  }
  return sent;
}

/** Fork: handoff, group chat and plan mode keep their state outside the projected fields. */
export function installForkUiRevision(state: ChatPageHost & { forkUiRevision: number }): void {
  state.requestUpdate = () => {
    state.forkUiRevision += 1;
  };
}
