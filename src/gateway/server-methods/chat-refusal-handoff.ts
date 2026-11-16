import { Type } from "typebox";
import { Value } from "typebox/value";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { readSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { excludeRefusedTurnFromContext } from "../../sessions/refused-turn-exclusion.js";
import { resolveRequestedSessionStoreTarget } from "../session-store-key.js";
import type { GatewayRequestHandlers } from "./types.js";

/**
 * Fork (I14): `chat.refusal.handoff { sessionKey, agentId?, messageId, signal, target? }` runs
 * when the user hands a refused reply off from the Control UI's refusal hint. It writes a gateway
 * log line and leaves the refused turn (question and reply) out of the model context while it
 * stays in the visible chat; the UI then switches the answerer and re-sends the question.
 * Nothing switches automatically: the user decides by the button (Anthropic's usage policy
 * forbids intentionally bypassing safeguards).
 */
const ChatRefusalHandoffParamsSchema = Type.Object(
  {
    sessionKey: Type.String({ minLength: 1, maxLength: 512 }),
    agentId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    messageId: Type.String({ minLength: 1, maxLength: 256 }),
    signal: Type.Union([Type.Literal("provider"), Type.Literal("marker"), Type.Literal("phrase")]),
    target: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  },
  { additionalProperties: false },
);

export type ChatRefusalHandoffResult = { excluded: string[] };

export function createChatRefusalHandoffHandlers(
  exclude: typeof excludeRefusedTurnFromContext = excludeRefusedTurnFromContext,
  readEntry: typeof readSessionEntryReadOnlyInWorker = readSessionEntryReadOnlyInWorker,
): GatewayRequestHandlers {
  return {
    "chat.refusal.handoff": async ({ params, respond, context, sessionMutationAuthorization }) => {
      if (!Value.Check(ChatRefusalHandoffParamsSchema, params)) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "chat.refusal.handoff expects { sessionKey, agentId?, messageId, signal, target? }",
          ),
        );
        return;
      }
      const cfg = context.getRuntimeConfig();
      const requested = resolveRequestedSessionStoreTarget(cfg, params.sessionKey, params.agentId);
      if (!requested.ok) {
        respond(false, undefined, requested.error);
        return;
      }
      const { agentId, sessionKey } = requested.value;
      const target = params.target?.replace(/[\p{Cc}\s]+/gu, " ").trim() || "unknown";
      try {
        const storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId });
        const entry = await readEntry({ agentId, sessionKey, storePath });
        sessionMutationAuthorization?.assertCurrent();
        const result = entry?.sessionId
          ? await exclude({
              target: { agentId, sessionId: entry.sessionId, sessionKey, storePath },
              messageId: params.messageId,
              signal: params.signal,
            })
          : { entryIds: [], excluded: [] };
        context.logGateway.info(
          `chat refusal handoff: session=${sessionKey} message=${params.messageId} ` +
            `signal=${params.signal} to=${JSON.stringify(target)} ` +
            `excluded=${result.excluded.length}/${result.entryIds.length}`,
        );
        const response: ChatRefusalHandoffResult = { excluded: result.excluded };
        respond(true, response);
      } catch (error) {
        context.logGateway.warn(
          `chat refusal handoff failed: session=${sessionKey} message=${params.messageId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.UNAVAILABLE,
            error instanceof Error ? error.message : "The refused turn could not be marked.",
          ),
        );
      }
    },
  };
}

export const chatRefusalHandoffHandlers = createChatRefusalHandoffHandlers();
