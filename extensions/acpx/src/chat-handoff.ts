/**
 * Fork: chat handoff state for the Control UI's model and agent switch buttons.
 * `acpx.chat.handoff.get` reports which ACP agent a chat is bound to (`/acp spawn ... --bind
 * here`) and the last handoff (who answered before, who answers now); `acpx.chat.handoff.set`
 * records a handoff and queues a one-shot note for the next model turn naming the new answerer.
 * Nothing here is provider-specific: a side is either a model ref or an ACP agent id.
 */
import { getSessionBindingService } from "openclaw/plugin-sdk/session-binding-runtime";
import type { OpenClawPluginApi } from "../runtime-api.js";

export type ChatAnswerer =
  | { kind: "model"; model: string; agentRuntime?: string }
  | { kind: "agent"; agent: string };

export type ChatHandoffRecord = { previous: ChatAnswerer; current: ChatAnswerer; at: number };

export type ChatAcpBinding = { agent: string; targetSessionKey: string; boundAt?: number };

type HandoffStore = {
  lookup(key: string): Promise<ChatHandoffRecord | undefined>;
  register(key: string, value: ChatHandoffRecord): Promise<void>;
  delete(key: string): Promise<boolean>;
};

const ACP_SESSION_KEY_RE = /^agent:[^:]+:acp:/u;
const MAX_FIELD_CHARS = 512;

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() && value.length <= MAX_FIELD_CHARS
    ? value.trim()
    : undefined;
}

export function parseChatAnswerer(value: unknown): ChatAnswerer | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (record.kind === "agent") {
    const agent = readString(record.agent);
    return agent ? { kind: "agent", agent } : undefined;
  }
  if (record.kind === "model") {
    const model = readString(record.model);
    const agentRuntime = readString(record.agentRuntime);
    return model ? { kind: "model", model, ...(agentRuntime ? { agentRuntime } : {}) } : undefined;
  }
  return undefined;
}

export function describeChatAnswerer(answerer: ChatAnswerer): string {
  return answerer.kind === "agent"
    ? `the ACP agent ${answerer.agent}`
    : `the model ${answerer.model}`;
}

/**
 * One-shot note for the next turn after a switch (prior art: Hermes Agent's model-switch note):
 * the earlier replies keep their authors, so the new answerer does not adopt them.
 */
export function buildChatHandoffNote(record: ChatHandoffRecord): string {
  return (
    `[System: The active model for this chat has changed from ${describeChatAnswerer(record.previous)} ` +
    `to ${describeChatAnswerer(record.current)}. Earlier assistant replies were written by whoever ` +
    "answered then; do not claim another model's or agent's replies as your own.]"
  );
}

/** Conversation ids a Control UI chat may be bound under (`--bind here` uses the session key). */
function bindingConversationIds(sessionKey: string, agentId?: string): string[] {
  return sessionKey.startsWith("agent:")
    ? [sessionKey]
    : [sessionKey, `agent:${agentId ?? "main"}:${sessionKey}`];
}

export async function resolveChatAcpBinding(
  sessionKey: string,
  agentId?: string,
): Promise<ChatAcpBinding | undefined> {
  const service = getSessionBindingService();
  for (const conversationId of bindingConversationIds(sessionKey, agentId)) {
    const binding = await service.resolveByConversationAsync({
      channel: "webchat",
      accountId: "default",
      conversationId,
    });
    const target = binding?.targetSessionKey?.trim();
    if (!binding || !target || !ACP_SESSION_KEY_RE.test(target)) {
      continue;
    }
    // `/acp spawn <agent>` records the agent id as the label unless --label overrides it.
    const metadata = binding.metadata ?? {};
    const agent = readString(metadata.label) ?? readString(metadata.agentId) ?? target;
    return {
      agent,
      targetSessionKey: target,
      ...(typeof binding.boundAt === "number" ? { boundAt: binding.boundAt } : {}),
    };
  }
  return undefined;
}

/**
 * ACP agents a chat can be handed to: `acp.allowedAgents`, else `acp.defaultAgent`; none when
 * `acp.enabled` is false. An empty allow-list admits any agent, but the UI needs names to offer.
 */
export function listHandoffAcpAgents(acp: Record<string, unknown> | undefined): string[] {
  if (acp?.enabled === false) {
    return [];
  }
  const allowed = Array.isArray(acp?.allowedAgents)
    ? acp.allowedAgents.flatMap((agent) => readString(agent) ?? [])
    : [];
  const fallback = readString(acp?.defaultAgent);
  return [...new Set(allowed.length > 0 ? allowed : fallback ? [fallback] : [])];
}

function readParams(params: Record<string, unknown>, allowed: readonly string[]) {
  const unknown = Object.keys(params).filter((key) => !allowed.includes(key));
  const sessionKey = readString(params.sessionKey);
  const agentId = readString(params.agentId);
  return unknown.length > 0 || !sessionKey
    ? undefined
    : { sessionKey, ...(agentId ? { agentId } : {}) };
}

/** The store opens on first use; registering the plugin must not touch runtime state. */
export function registerChatHandoff(api: OpenClawPluginApi, openStore: () => HandoffStore): void {
  let opened: HandoffStore | undefined;
  const store = () => (opened ??= openStore());
  api.registerGatewayMethod(
    "acpx.chat.handoff.get",
    async ({ params, respond }) => {
      const parsed = readParams(params, ["sessionKey", "agentId"]);
      if (!parsed) {
        respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: "acpx.chat.handoff.get takes { sessionKey, agentId? }",
        });
        return;
      }
      try {
        const [binding, handoff] = await Promise.all([
          resolveChatAcpBinding(parsed.sessionKey, parsed.agentId),
          store().lookup(parsed.sessionKey),
        ]);
        const agents = listHandoffAcpAgents(
          api.runtime.config.current().acp as Record<string, unknown> | undefined,
        );
        respond(true, { binding: binding ?? null, handoff: handoff ?? null, agents }, undefined);
      } catch (error) {
        respond(false, undefined, { code: "UNAVAILABLE", message: String(error) });
      }
    },
    { scope: "operator.read", profileAccess: "independent" },
  );
  api.registerGatewayMethod(
    "acpx.chat.handoff.set",
    async ({ params, respond }) => {
      const parsed = readParams(params, ["sessionKey", "agentId", "previous", "current"]);
      const previous = parseChatAnswerer(params.previous);
      const current = parseChatAnswerer(params.current);
      const clear = params.previous === null && params.current === null;
      if (!parsed || (!clear && (!previous || !current))) {
        respond(false, undefined, {
          code: "INVALID_REQUEST",
          message:
            "acpx.chat.handoff.set takes { sessionKey, agentId?, previous, current } (both null clears)",
        });
        return;
      }
      try {
        if (clear || !previous || !current) {
          await store().delete(parsed.sessionKey);
          respond(true, { handoff: null }, undefined);
          return;
        }
        const record: ChatHandoffRecord = { previous, current, at: Date.now() };
        await store().register(parsed.sessionKey, record);
        // The note reaches runtimes that drain plugin next-turn context; a later switch
        // before that turn adds its own note under a new key.
        await api.session.workflow
          .enqueueNextTurnInjection({
            sessionKey: parsed.sessionKey,
            ...(parsed.agentId ? { agentId: parsed.agentId } : {}),
            text: buildChatHandoffNote(record),
            idempotencyKey: `chat-handoff:${record.at}`,
            placement: "prepend_context",
            ttlMs: 24 * 60 * 60 * 1000,
          })
          .catch(() => undefined);
        respond(true, { handoff: record }, undefined);
      } catch (error) {
        respond(false, undefined, { code: "UNAVAILABLE", message: String(error) });
      }
    },
    { scope: "operator.write", profileAccess: "independent" },
  );
}
