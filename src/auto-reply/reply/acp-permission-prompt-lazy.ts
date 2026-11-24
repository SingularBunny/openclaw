import type {
  AcpElicitationHandler,
  AcpPermissionPromptHandler,
} from "@openclaw/acp-core/runtime/types";
import { createLazyAcpElicitationHandler } from "./acp-elicitation-handler-lazy.js";
import type { AcpElicitationHandlerParams } from "./acp-elicitation-handler.js";
import type { AcpPermissionPromptHandlerParams } from "./acp-permission-prompt.js";
import { inAcpQuestionQueue } from "./acp-question-queue.js";
import { resolveAcpQuestionTarget } from "./acp-question-target.js";

/** Fork: defers the Gateway question stack until an ACP agent first asks for permission. */
export function createLazyAcpPermissionPromptHandler(
  params: AcpPermissionPromptHandlerParams,
): AcpPermissionPromptHandler {
  let handler: Promise<AcpPermissionPromptHandler> | undefined;
  return async (request, context) => {
    handler ??= import("./acp-permission-prompt.js").then(({ createAcpPermissionPromptHandler }) =>
      createAcpPermissionPromptHandler(params),
    );
    return (await handler)(request, context);
  };
}

/** Forms share the per-chat question queue with permission questions (`acp-question-queue.ts`). */
function queuedElicitation(
  sessionKey: string,
  handler: AcpElicitationHandler,
): AcpElicitationHandler {
  return async (request, context) =>
    await inAcpQuestionQueue(sessionKey, context.signal, () => handler(request, context));
}

/**
 * Fork: one channel turn's ACP input bridges. Both ask in the conversation the human typed
 * in (`conversationSessionKey`; for a bound chat, the chat; see `resolveAcpQuestionTarget`).
 */
export function createLazyAcpTurnInputHandlers(
  params: AcpElicitationHandlerParams & {
    agentLabel: string;
    conversationSessionKey: string | undefined;
  },
): { onElicitation: AcpElicitationHandler; onPermissionPrompt: AcpPermissionPromptHandler } {
  const { conversationSessionKey, agentLabel, ...elicitation } = params;
  const questionTarget = resolveAcpQuestionTarget({
    sourceSessionKey: conversationSessionKey,
    acpSessionKey: params.targetSessionKey,
    acpAgentId: params.agentId,
  });
  return {
    onElicitation: queuedElicitation(
      questionTarget.sessionKey,
      createLazyAcpElicitationHandler({
        ...elicitation,
        questionSessionKey: questionTarget.sessionKey,
        questionAgentId: questionTarget.agentId,
      }),
    ),
    onPermissionPrompt: createLazyAcpPermissionPromptHandler({
      sessionKey: questionTarget.sessionKey,
      outerRequestId: params.outerRequestId,
      agentLabel,
      agentId: questionTarget.agentId,
      runId: params.runId,
      delivery: params.delivery,
      isActive: params.isActive,
    }),
  };
}
