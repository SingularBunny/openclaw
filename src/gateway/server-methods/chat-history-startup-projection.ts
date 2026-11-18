import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { measureDiagnosticsTimelineSpan } from "../../infra/diagnostics-timeline.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { ChatHistoryMethod } from "./chat-history-recovery.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

type GatewayContext = GatewayRequestHandlerOptions["context"];
type StartupProjectionRequest = Parameters<
  NonNullable<GatewayContext["readChatStartupProjection"]>
>[0];

/** Prepared startup projection of a chat history read; a failed read continues without one. */
export function readChatHistoryStartupProjection(
  context: GatewayContext,
  method: ChatHistoryMethod,
  cfg: OpenClawConfig,
  agentId: string,
  sessionKey: string,
  entry: StartupProjectionRequest["sessionEntry"],
) {
  return measureDiagnosticsTimelineSpan(
    `gateway.${method}.startup_projection`,
    async () => {
      try {
        return await context.readChatStartupProjection?.({
          agentId,
          sessionKey,
          sessionEntry: entry,
          readPolicy: method === "chat.history" ? "ready" : "current",
        });
      } catch (error) {
        context.logGateway.debug(
          `${method} continuing without prepared startup projection: ${formatErrorMessage(error)}`,
        );
        return undefined;
      }
    },
    { config: cfg, phase: method, attributes: { agentId } },
  );
}
