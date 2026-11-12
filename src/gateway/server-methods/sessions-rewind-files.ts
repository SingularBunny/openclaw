import {
  ErrorCodes,
  errorShape,
  type SessionsRewindFilesParams,
  type SessionsRewindFilesResult,
  validateSessionsRewindFilesParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { withSessionActorStorage } from "../../config/sessions/session-actor-storage-binding.js";
import { resolveRequestedSessionAgentId as resolveRequestedGlobalAgentId } from "../session-request-agent.js";
import { withGatewaySessionEntryReadOnly } from "../session-utils-read-lifetime.js";
import { buildRewindFilesTarget, previewRewindFiles } from "./session-rewind-files.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";
import { defineValidatedGatewayHandler } from "./validation.js";

/**
 * Fork (F52): `sessions.rewind.files` asks the chat's idle Claude CLI process which files a
 * rewind before one message would restore (Claude's `rewind_files` dry run; Fork (V1): OpenClaw's
 * own file checkpoints in chats without a Claude CLI session). It changes nothing; `available: false` carries the reason shown in the rewind confirmation.
 */
export async function previewSessionRewindFilesForGateway(
  options: Omit<GatewayRequestHandlerOptions, "params"> & { params: SessionsRewindFilesParams },
): Promise<void> {
  const { params, respond, context } = options;
  const sessionKey = params.sessionKey.trim();
  const cfg = context.getRuntimeConfig();
  const requestedAgent = resolveRequestedGlobalAgentId(cfg, sessionKey, params.agentId);
  if (!requestedAgent.ok) {
    respond(false, undefined, requestedAgent.error);
    return;
  }
  const run = () =>
    withGatewaySessionEntryReadOnly(
      { key: sessionKey, cfg, agentId: requestedAgent.agentId, excludeInternalEffects: true },
      async (current, assertSourceCurrent) => {
        const entry = current.entry;
        if (!entry?.sessionId) {
          respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "session not found"));
          return;
        }
        const preview: SessionsRewindFilesResult = await previewRewindFiles(
          buildRewindFilesTarget(
            { ...current, entry: { ...entry, sessionId: entry.sessionId } },
            params,
            sessionKey,
          ),
        );
        assertSourceCurrent();
        respond(true, preview, undefined);
      },
    );
  const assertCurrent = () => {
    options.sessionMutationCommitGuard?.();
    options.sessionMutationAuthorization?.assertCurrent();
  };
  const handled = await withSessionActorStorage(
    { sessionKey, agentId: requestedAgent.agentId },
    {
      lifetime: { assertCurrent, assertReadable: assertCurrent },
      authority: { assertCurrent, authorize() {} },
    },
    async () => {
      await run();
      return true;
    },
  );
  if (!handled) {
    await run();
  }
}

/** Registered with the other message-cut methods in `sessions-rewind.ts`. */
export const sessionRewindFilesHandlers: GatewayRequestHandlers = {
  "sessions.rewind.files": defineValidatedGatewayHandler(
    "sessions.rewind.files",
    validateSessionsRewindFilesParams,
    previewSessionRewindFilesForGateway,
  ),
};
