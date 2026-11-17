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

export type AcpAgentIdentity = { name?: string; emoji?: string; avatar?: string };

const AVATAR_RE = /^(?:data:image\/[a-z0-9.+-]+;base64,|\/(?!\/))/iu;

function readIdentity(value: unknown): AcpAgentIdentity {
  const entry = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const name = readString(entry.name);
  const emoji = readString(entry.emoji);
  const avatar = typeof entry.avatar === "string" ? entry.avatar.trim() : "";
  return {
    ...(name && name.length <= 64 ? { name } : {}),
    ...(emoji && emoji.length <= 8 ? { emoji } : {}),
    ...(avatar && AVATAR_RE.test(avatar) ? { avatar } : {}),
  };
}

/**
 * Fork: how each ACP agent appears in chat. An OpenClaw agent whose runtime is that ACP agent
 * (`agents.entries.<id>.runtime.acp.agent`) lends its `identity`; the ACPX plugin config
 * `agentIdentities.<agent>` (name, emoji, avatar) overrides it field by field. An avatar the
 * Control UI cannot render (not a data:image URL or a Gateway path) is dropped, so the agent
 * keeps its generated face.
 */
export function readAcpAgentIdentities(config: unknown): Record<string, AcpAgentIdentity> {
  const root = (config ?? {}) as {
    agents?: { entries?: unknown };
    plugins?: { entries?: Record<string, unknown> };
  };
  const result: Record<string, AcpAgentIdentity> = {};
  const entries = root.agents?.entries;
  if (entries && typeof entries === "object" && !Array.isArray(entries)) {
    for (const value of Object.values(entries as Record<string, unknown>)) {
      const entry = (value ?? {}) as { runtime?: unknown; identity?: unknown };
      const runtime = (entry.runtime ?? {}) as { type?: unknown; acp?: { agent?: unknown } };
      const agent = runtime.type === "acp" ? readString(runtime.acp?.agent) : undefined;
      if (agent && entry.identity) {
        result[agent] = { ...result[agent], ...readIdentity(entry.identity) };
      }
    }
  }
  const acpx = root.plugins?.entries?.acpx as
    | { config?: { agentIdentities?: unknown } }
    | undefined;
  const raw = acpx?.config?.agentIdentities;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [agent, value] of Object.entries(raw as Record<string, unknown>)) {
      result[agent] = { ...result[agent], ...readIdentity(value) };
    }
  }
  return result;
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
        const config = api.runtime.config.current();
        const agents = listHandoffAcpAgents(config.acp as Record<string, unknown> | undefined);
        const identities = readAcpAgentIdentities(config);
        respond(
          true,
          { binding: binding ?? null, handoff: handoff ?? null, agents, identities },
          undefined,
        );
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
