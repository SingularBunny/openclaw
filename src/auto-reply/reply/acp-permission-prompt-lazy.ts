import type {
  AcpElicitationHandler,
  AcpPermissionPromptHandler,
} from "@openclaw/acp-core/runtime/types";
import { createLazyAcpElicitationHandler } from "./acp-elicitation-handler-lazy.js";
import type { AcpElicitationHandlerParams } from "./acp-elicitation-handler.js";
import type { AcpPermissionPromptHandlerParams } from "./acp-permission-prompt.js";

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

/** Fork: one channel turn's ACP input bridges, both asked in the target session's chat. */
export function createLazyAcpTurnInputHandlers(
  params: AcpElicitationHandlerParams & { agentLabel: string },
): { onElicitation: AcpElicitationHandler; onPermissionPrompt: AcpPermissionPromptHandler } {
  return {
    onElicitation: createLazyAcpElicitationHandler(params),
    onPermissionPrompt: createLazyAcpPermissionPromptHandler({
      sessionKey: params.targetSessionKey,
      outerRequestId: params.outerRequestId,
      agentLabel: params.agentLabel,
      agentId: params.agentId,
      runId: params.runId,
      delivery: params.delivery,
      isActive: params.isActive,
    }),
  };
}
