import type { MessageGroupFrame } from "./chat-message-group-frame.ts";

/** Fork: an ACP agent's reply shows that agent's avatar; other replies keep the chat agent's. */
export function groupAssistantAvatar(frame: MessageGroupFrame) {
  const author = frame.authorIdentity;
  return author?.kind === "agent"
    ? {
        agentId: author.avatarId,
        name: author.name,
        avatar: author.avatar,
        textAvatar: author.textAvatar,
      }
    : {
        agentId: frame.options.agentId,
        name: frame.assistantName,
        avatar: frame.options.assistantAvatar ?? null,
        textAvatar: frame.options.assistantTextAvatar,
      };
}
