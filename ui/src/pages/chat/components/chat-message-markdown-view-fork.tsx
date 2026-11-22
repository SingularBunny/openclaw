// Fork: what the fork adds under a chat message — plugin "message" actions, the hand-off and
// failed-turn buttons (chat-handoff-view.tsx) and the refusal hint (I14). Kept out of
// chat-message-markdown-view.tsx so upstream ports touch less.
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { Show } from "solid-js";
import {
  matchesRefusalPhrase,
  readRefusalHandoff,
  readStoredRefusal,
  type RefusalSignal,
} from "../../../../../src/shared/refusal-signal.js";
import { PluginMessageActions } from "../../../plugins/control-ui-message-actions.solid.tsx";
import { ChatHandoffMessageAction, ChatTurnFailureActions } from "./chat-handoff-view.tsx";
import type { MessageActionDetails } from "./chat-message-markdown.types.ts";

/**
 * Fork (I14): the refusal signal of an assistant reply, strongest first: the API's (recorded
 * by any provider), the model's own marker, else a weak phrase match. A turn already handed
 * off from the hint is out of the model context and shows no hint.
 */
export function resolveRefusalHint(
  message: unknown,
  visibleMarkdown: string,
): { refusal?: RefusalSignal } {
  if (readRefusalHandoff(message)) {
    return {};
  }
  const stored = readStoredRefusal(message);
  if (stored) {
    return { refusal: stored.signal };
  }
  return matchesRefusalPhrase(visibleMarkdown) ? { refusal: "phrase" } : {};
}

/** The fork's fields of MessageActionDetails; empty without the chat's session. */
export function forkMessageActionDetails(params: {
  message: unknown;
  role: string;
  pendingInput: boolean;
  isConversationMessage: boolean;
  copyMarkdown: string;
  visibleMarkdown: string;
  sourceMessageId: string | null;
  sessionKey?: string;
  agentId?: string;
}): Pick<MessageActionDetails, "pluginMessage" | "handoff"> {
  const { message, role, pendingInput, copyMarkdown, sourceMessageId, sessionKey } = params;
  return {
    ...(params.isConversationMessage && !pendingInput && copyMarkdown && sessionKey
      ? {
          pluginMessage: {
            sessionKey,
            ...(params.agentId ? { agentId: params.agentId } : {}),
            message: {
              role,
              text: copyMarkdown,
              ...(sourceMessageId ? { id: sourceMessageId } : {}),
            },
          },
        }
      : {}),
    ...(role === "assistant" && !pendingInput && sessionKey
      ? {
          handoff: {
            sessionKey,
            ...(sourceMessageId ? { messageKey: sourceMessageId } : {}),
            failed: asNullableRecord(message)?.stopReason === "error",
            ...resolveRefusalHint(message, params.visibleMarkdown),
          },
        }
      : {}),
  };
}

/** The fork's buttons in a message's action row. */
export function ForkMessageActions(props: { details: MessageActionDetails | null | undefined }) {
  return (
    <>
      <Show when={props.details?.handoff?.failed}>
        <ChatTurnFailureActions
          sessionKey={props.details!.handoff!.sessionKey}
          messageKey={props.details!.handoff!.messageKey}
        />
      </Show>
      <Show when={props.details?.handoff}>
        <ChatHandoffMessageAction
          sessionKey={props.details!.handoff!.sessionKey}
          messageKey={props.details!.handoff!.messageKey}
        />
      </Show>
      <Show when={props.details?.pluginMessage}>
        <PluginMessageActions
          sessionKey={props.details!.pluginMessage!.sessionKey}
          agentId={props.details!.pluginMessage!.agentId}
          message={props.details!.pluginMessage!.message}
        />
      </Show>
    </>
  );
}
