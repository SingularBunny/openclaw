// Commands gateway methods expose validated command listing for a resolved
// agent, provider, scope, and argument-detail request.
import {
  ErrorCodes,
  errorShape,
  validateCommandsClaudeParams,
  validateCommandsListParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type { CommandsClaudeResult } from "../../../packages/gateway-protocol/src/schema/commands.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { readClaudeNativeCommands } from "../../infra/claude-native-commands.js";
import { resolveAgentIdOrRespondError } from "./agent-id-shared.js";
import { buildCommandsListResult } from "./commands-list-result.js";
import { withSessionDiscoveryAccess } from "./session-discovery-access.js";
import type { GatewayRequestHandlers } from "./types.js";
import { defineValidatedGatewayMethod } from "./validation.js";

const CLAUDE_CLI_BACKEND_ID = "claude-cli";

/**
 * Fork (F51): Claude CLI's own commands and skills for the session. A session that has not run
 * yet borrows the agent's latest list unless it is already bound to another CLI backend.
 */
export function buildClaudeCommandsResult(params: {
  agentId: string;
  sessionEntry?: SessionEntry;
}): CommandsClaudeResult {
  const bindings = Object.keys(params.sessionEntry?.cliSessionBindings ?? {});
  const snapshot = readClaudeNativeCommands({
    sessionId: params.sessionEntry?.sessionId,
    agentId: params.agentId,
    agentFallback: bindings.length === 0 || bindings.includes(CLAUDE_CLI_BACKEND_ID),
  });
  if (!snapshot) {
    return { commands: [] };
  }
  return {
    commands: snapshot.commands.map((command) => ({ name: command.name, kind: command.kind })),
    capturedAt: snapshot.capturedAt,
    ...(snapshot.fromAgent ? { fromAgent: true } : {}),
  };
}

/** Gateway handler for enumerating available chat/native commands. */
export const commandsHandlers: GatewayRequestHandlers = {
  "commands.list": defineValidatedGatewayMethod(
    "commands.list",
    validateCommandsListParams,
    async ({ params, respond, context, client, signal, hasCurrentClientAuthority }) => {
      const resolved = resolveAgentIdOrRespondError({
        rawAgentId: params.agentId,
        respond,
        cfg: context.getRuntimeConfig(),
      });
      if (!resolved) {
        return;
      }
      await withSessionDiscoveryAccess(
        {
          client,
          context,
          respond,
          signal,
          hasCurrentClientAuthority,
          sessionKey: params.sessionKey,
          agentId: resolved.agentId,
          changedError: errorShape(
            ErrorCodes.UNAVAILABLE,
            "Session changed while preparing its commands. Retry the request.",
          ),
        },
        (sessionEntry) =>
          buildCommandsListResult({
            cfg: resolved.cfg,
            agentId: resolved.agentId,
            provider: params.provider,
            scope: params.scope,
            includeArgs: params.includeArgs,
            sessionKey: params.sessionKey,
            sessionEntry,
          }),
      );
    },
  ),
  "commands.claude": defineValidatedGatewayMethod(
    "commands.claude",
    validateCommandsClaudeParams,
    async ({ params, respond, context, client, signal, hasCurrentClientAuthority }) => {
      const resolved = resolveAgentIdOrRespondError({
        rawAgentId: params.agentId,
        respond,
        cfg: context.getRuntimeConfig(),
      });
      if (!resolved) {
        return;
      }
      await withSessionDiscoveryAccess(
        {
          client,
          context,
          respond,
          signal,
          hasCurrentClientAuthority,
          sessionKey: params.sessionKey,
          agentId: resolved.agentId,
          changedError: errorShape(
            ErrorCodes.UNAVAILABLE,
            "Session changed while reading its Claude commands. Retry the request.",
          ),
        },
        async (sessionEntry) =>
          buildClaudeCommandsResult({ agentId: resolved.agentId, sessionEntry }),
      );
    },
  ),
};
