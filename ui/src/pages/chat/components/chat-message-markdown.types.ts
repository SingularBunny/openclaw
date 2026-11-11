import type { ChatReplyTarget } from "../../../lib/chat/chat-types.ts";
import type { ControlUiMessage } from "../../../../../src/plugin-sdk/control-ui.js";
import type { AssistantMessageExpansionState } from "../chat-message-recovery.ts";

export type MessageReplyTarget = ChatReplyTarget;

export type MessageActionDetails = {
  /** Source for context copy, independent of footer visibility and reply truncation. */
  copyMarkdown?: string;
  markdown?: string;
  readAloudText?: string;
  fullMessage?: { messageId: string; state: AssistantMessageExpansionState | undefined };
  replyTarget?: MessageReplyTarget;
  reactionMessageId?: string;
  /** Fork: what plugin "message" actions run on — the chat's session and this message. */
  pluginMessage?: { sessionKey: string; agentId?: string; message: ControlUiMessage };
};
