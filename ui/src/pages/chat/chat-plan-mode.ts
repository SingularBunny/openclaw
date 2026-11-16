// Fork: the Plan toggle in the composer — the same switch as `/plan` and `/plan off` from the
// workbench plan mode plugin (aiwb-plan), read and flipped through its Gateway methods. The toggle
// is present only when the Gateway advertises them; nothing here depends on the chat's model.
import { t } from "../../i18n/index.ts";
import { registerModelControlsEnglish } from "../../i18n/locales/en-model-controls.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import type { ChatPlanModeToggleProps } from "./components/chat-plan-mode-toggle.types.ts";

registerModelControlsEnglish();

export const CHAT_PLAN_STATUS_METHOD = "aiwb-plan.status";
export const CHAT_PLAN_SET_METHOD = "aiwb-plan.set";

type PlanModeHost = Pick<ChatPageHost, "client" | "hello" | "connected" | "requestUpdate">;
type PlanState = { on: boolean };

const stateByHost = new WeakMap<object, Map<string, PlanState>>();
const loading = new WeakMap<object, Set<string>>();
const switching = new WeakMap<object, Set<string>>();

function snapshot(host: PlanModeHost) {
  return {
    client: host.client,
    hello: host.hello,
    phase: host.connected ? ("connected" as const) : ("offline" as const),
  };
}

function scopeKey(sessionKey: string, agentId?: string) {
  return JSON.stringify([sessionKey, agentId ?? null]);
}

function setOf(map: WeakMap<object, Set<string>>, host: object) {
  const set = map.get(host) ?? new Set<string>();
  map.set(host, set);
  return set;
}

export function canReadChatPlanMode(host: PlanModeHost): boolean {
  return canCallGatewayMethod(snapshot(host), CHAT_PLAN_STATUS_METHOD, "operator.read");
}

export function canSetChatPlanMode(host: PlanModeHost): boolean {
  return canCallGatewayMethod(snapshot(host), CHAT_PLAN_SET_METHOD, "operator.write");
}

export function readChatPlanMode(host: object, sessionKey: string, agentId?: string) {
  return stateByHost.get(host)?.get(scopeKey(sessionKey, agentId));
}

function storePlanMode(
  host: PlanModeHost,
  sessionKey: string,
  agentId: string | undefined,
  on: boolean,
) {
  const map = stateByHost.get(host) ?? new Map<string, PlanState>();
  stateByHost.set(host, map);
  const key = scopeKey(sessionKey, agentId);
  const changed = map.get(key)?.on !== on;
  map.set(key, { on });
  if (changed) {
    host.requestUpdate?.();
  }
}

function params(sessionKey: string, agentId?: string) {
  return { sessionKey, ...(agentId ? { agentId } : {}) };
}

/** Re-reads the chat's plan mode: after a turn, since `/plan` and an approved plan change it. */
export async function refreshChatPlanMode(
  host: PlanModeHost,
  sessionKey: string,
  agentId?: string,
): Promise<PlanState | undefined> {
  if (!host.client || !canReadChatPlanMode(host)) {
    return undefined;
  }
  try {
    const result = await host.client.request<{ on?: unknown }>(
      CHAT_PLAN_STATUS_METHOD,
      params(sessionKey, agentId),
    );
    storePlanMode(host, sessionKey, agentId, result?.on === true);
  } catch {
    // Keep the last known state; the toggle stays usable and the next read retries.
  }
  return readChatPlanMode(host, sessionKey, agentId);
}

/** Loads the chat's plan mode once; later reads follow the toggle and finished turns. */
export function ensureChatPlanMode(host: PlanModeHost, sessionKey: string, agentId?: string) {
  const key = scopeKey(sessionKey, agentId);
  const pending = setOf(loading, host);
  if (readChatPlanMode(host, sessionKey, agentId) || pending.has(key)) {
    return;
  }
  pending.add(key);
  void refreshChatPlanMode(host, sessionKey, agentId).finally(() => pending.delete(key));
}

export async function setChatPlanMode(
  host: PlanModeHost & Pick<ChatPageHost, "chatError" | "lastError">,
  sessionKey: string,
  agentId: string | undefined,
  on: boolean,
): Promise<boolean> {
  const key = scopeKey(sessionKey, agentId);
  const busy = setOf(switching, host);
  if (!host.client || busy.has(key) || !canSetChatPlanMode(host)) {
    return false;
  }
  busy.add(key);
  host.requestUpdate?.();
  try {
    const result = await host.client.request<{ on?: unknown }>(CHAT_PLAN_SET_METHOD, {
      ...params(sessionKey, agentId),
      on,
    });
    storePlanMode(host, sessionKey, agentId, result?.on === true);
    return result?.on === on;
  } catch (error) {
    host.chatError = host.lastError = t("chat.planMode.updateFailed", { error: String(error) });
    return false;
  } finally {
    busy.delete(key);
    host.requestUpdate?.();
  }
}

/** The composer toggle's props, or undefined when the Gateway has no plan mode plugin. */
export function buildChatPlanModeToggle(
  host: PlanModeHost & Pick<ChatPageHost, "chatError" | "lastError">,
  sessionKey: string,
  agentId?: string,
): ChatPlanModeToggleProps | undefined {
  if (!sessionKey || !canReadChatPlanMode(host)) {
    return undefined;
  }
  ensureChatPlanMode(host, sessionKey, agentId);
  const state = readChatPlanMode(host, sessionKey, agentId);
  const canSet = canSetChatPlanMode(host);
  return {
    on: state?.on === true,
    known: Boolean(state),
    pending: setOf(switching, host).has(scopeKey(sessionKey, agentId)),
    disabled: !canSet,
    disabledReason: canSet ? undefined : t("chat.planMode.readOnly"),
    onToggle: (on) => setChatPlanMode(host, sessionKey, agentId, on),
  };
}
