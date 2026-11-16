/**
 * Fork: the models of the ACP agent bound to a chat, for the Control UI's model picker — the button
 * form of `/acp model <id>`. `acpx.chat.models.get` reads the models the agent advertised for the
 * bound ACP session (ACP `models` or a config option of category "model"; acpx keeps them in its
 * session record, so no turn is started); `acpx.chat.models.set` sets one through the same session
 * manager call as `/acp model`. Nothing here is agent-specific.
 */
import { getAcpSessionManager } from "openclaw/plugin-sdk/acp-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { OpenClawPluginApi } from "../runtime-api.js";
import { resolveChatAcpBinding } from "./chat-handoff.js";

export type ChatAcpModel = { id: string; name?: string };

export type ChatAcpModels = {
  agent: string;
  /** The model the session uses now, if the agent says. */
  current: string | null;
  /** Empty when the agent advertises no models (then only `/acp model <id>` can set one). */
  models: ChatAcpModel[];
};

type SessionManager = Pick<
  ReturnType<typeof getAcpSessionManager>,
  "getSessionStatus" | "setSessionConfigOption"
>;

const MAX_FIELD_CHARS = 512;

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() && value.length <= MAX_FIELD_CHARS
    ? value.trim()
    : undefined;
}

/**
 * The advertised models in an ACP runtime status (`models: { currentModelId, availableModelIds,
 * availableModels: [{ modelId, name }] }`), without trusting its shape.
 */
export function readAdvertisedAcpModels(runtimeStatus: unknown): {
  current?: string;
  models: ChatAcpModel[];
} {
  const record =
    runtimeStatus && typeof runtimeStatus === "object"
      ? (runtimeStatus as Record<string, unknown>).models
      : undefined;
  if (!record || typeof record !== "object") {
    return { models: [] };
  }
  const models = record as Record<string, unknown>;
  const byId = new Map<string, ChatAcpModel>();
  if (Array.isArray(models.availableModels)) {
    for (const entry of models.availableModels) {
      const item = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
      const id = readString(item.modelId) ?? readString(item.id);
      if (id && !byId.has(id)) {
        const name = readString(item.name);
        byId.set(id, name && name !== id ? { id, name } : { id });
      }
    }
  }
  if (Array.isArray(models.availableModelIds)) {
    for (const entry of models.availableModelIds) {
      const id = readString(entry);
      if (id && !byId.has(id)) {
        byId.set(id, { id });
      }
    }
  }
  const current = readString(models.currentModelId);
  return { ...(current ? { current } : {}), models: [...byId.values()] };
}

function readParams(params: Record<string, unknown>, allowed: readonly string[]) {
  const unknown = Object.keys(params).filter((key) => !allowed.includes(key));
  const sessionKey = readString(params.sessionKey);
  const agentId = readString(params.agentId);
  return unknown.length > 0 || !sessionKey
    ? undefined
    : { sessionKey, ...(agentId ? { agentId } : {}) };
}

export function registerChatAcpModels(
  api: OpenClawPluginApi,
  manager: () => SessionManager = getAcpSessionManager,
): void {
  const cfg = () => api.runtime.config.current() as OpenClawConfig;
  api.registerGatewayMethod(
    "acpx.chat.models.get",
    async ({ params, respond }) => {
      const parsed = readParams(params, ["sessionKey", "agentId"]);
      if (!parsed) {
        respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: "acpx.chat.models.get takes { sessionKey, agentId? }",
        });
        return;
      }
      try {
        const binding = await resolveChatAcpBinding(parsed.sessionKey, parsed.agentId);
        if (!binding) {
          respond(true, { binding: null, models: null }, undefined);
          return;
        }
        const status = await manager().getSessionStatus({
          cfg: cfg(),
          sessionKey: binding.targetSessionKey,
        });
        const advertised = readAdvertisedAcpModels(status.runtimeStatus);
        const chosen = readString(status.runtimeOptions?.model);
        const result: ChatAcpModels = {
          agent: binding.agent,
          current: advertised.current ?? chosen ?? null,
          models: advertised.models,
        };
        respond(true, { binding, models: result }, undefined);
      } catch (error) {
        respond(false, undefined, { code: "UNAVAILABLE", message: String(error) });
      }
    },
    { scope: "operator.read", profileAccess: "independent" },
  );
  api.registerGatewayMethod(
    "acpx.chat.models.set",
    async ({ params, respond }) => {
      const parsed = readParams(params, ["sessionKey", "agentId", "model"]);
      const model = readString(params.model);
      if (!parsed || !model) {
        respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: "acpx.chat.models.set takes { sessionKey, agentId?, model }",
        });
        return;
      }
      try {
        const binding = await resolveChatAcpBinding(parsed.sessionKey, parsed.agentId);
        if (!binding) {
          respond(false, undefined, {
            code: "INVALID_REQUEST",
            message: "No ACP agent is bound to this chat.",
          });
          return;
        }
        // The same call as `/acp model <id>`: the runtime option "model" on the bound ACP session.
        const options = await manager().setSessionConfigOption({
          cfg: cfg(),
          sessionKey: binding.targetSessionKey,
          key: "model",
          value: model,
        });
        respond(true, { agent: binding.agent, model: options.model ?? model }, undefined);
      } catch (error) {
        respond(false, undefined, { code: "UNAVAILABLE", message: String(error) });
      }
    },
    { scope: "operator.write", profileAccess: "independent" },
  );
}
