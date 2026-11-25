// Fork: the composer's Permissions toggle of a chat bound to an ACP agent: the bound ACP session asks
// for each permission request ("Ask") or allows all of them ("Allow all"). The mode lives on the ACP
// session in the acpx plugin (acpx.chat.permissions.get/set); "Allow all in this chat" in a
// permission question switches the same mode.
import { t } from "../../i18n/index.ts";
import { registerModelControlsEnglish } from "../../i18n/locales/en-model-controls.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { registerEnglishCatalog } from "../../lib/reactive/i18n.ts";
import { readChatHandoffInfo } from "./chat-handoff.ts";
import { setChatError } from "./chat-history-state.ts";
import type { ChatPageHost } from "./chat-state-host.ts";

registerEnglishCatalog(registerModelControlsEnglish);

export const CHAT_ACP_PERMISSIONS_GET_METHOD = "acpx.chat.permissions.get";
export const CHAT_ACP_PERMISSIONS_SET_METHOD = "acpx.chat.permissions.set";

export type ChatAcpPermissionMode = "ask" | "allow-all";

type ChatAcpPermissionsState = {
  target: string;
  available: boolean;
  mode: ChatAcpPermissionMode;
  pending?: ChatAcpPermissionMode;
  /** The chat run the mode was last read for; a run start or end re-reads it. */
  runId: string | null;
};

export type ChatAcpPermissionToggleProps = {
  agent: string;
  mode: ChatAcpPermissionMode;
  pending: boolean;
  disabled: boolean;
  onSelect: (mode: ChatAcpPermissionMode) => unknown;
};

const statesByHost = new WeakMap<object, Map<string, ChatAcpPermissionsState>>();
const loading = new WeakMap<object, Set<string>>();

function gatewaySnapshot(state: ChatPageHost) {
  return {
    client: state.client,
    hello: state.hello,
    phase: state.connected ? ("connected" as const) : ("offline" as const),
  };
}

function readState(state: ChatPageHost, sessionKey: string) {
  return statesByHost.get(state)?.get(sessionKey);
}

function storeState(state: ChatPageHost, sessionKey: string, next: ChatAcpPermissionsState) {
  const map = statesByHost.get(state) ?? new Map<string, ChatAcpPermissionsState>();
  statesByHost.set(state, map);
  map.set(sessionKey, next);
  state.requestUpdate?.();
}

export function readChatAcpPermissionMode(value: unknown): ChatAcpPermissionMode | undefined {
  return value === "ask" || value === "allow-all" ? value : undefined;
}

export async function refreshChatAcpPermissions(
  state: ChatPageHost,
  sessionKey = state.sessionKey,
): Promise<void> {
  const target = readChatHandoffInfo(state, sessionKey)?.binding?.targetSessionKey;
  if (
    !state.client ||
    !target ||
    !canCallGatewayMethod(gatewaySnapshot(state), CHAT_ACP_PERMISSIONS_GET_METHOD, "operator.read")
  ) {
    return;
  }
  const runId = state.chatRunId ?? null;
  try {
    const result = await state.client.request<{ available?: unknown; mode?: unknown }>(
      CHAT_ACP_PERMISSIONS_GET_METHOD,
      { sessionKey },
    );
    storeState(state, sessionKey, {
      target,
      available: result?.available === true,
      mode: readChatAcpPermissionMode(result?.mode) ?? "ask",
      runId,
    });
  } catch {
    // An older acpx without the method: no toggle.
    storeState(state, sessionKey, { target, available: false, mode: "ask", runId });
  }
}

/** Reads the mode once per bound ACP session, and again when a chat run starts or ends. */
export function ensureChatAcpPermissions(state: ChatPageHost, sessionKey = state.sessionKey) {
  const target = readChatHandoffInfo(state, sessionKey)?.binding?.targetSessionKey;
  const current = readState(state, sessionKey);
  const pending = loading.get(state) ?? new Set<string>();
  loading.set(state, pending);
  if (
    !target ||
    pending.has(sessionKey) ||
    (current?.target === target && current.runId === (state.chatRunId ?? null))
  ) {
    return;
  }
  pending.add(sessionKey);
  void refreshChatAcpPermissions(state, sessionKey).finally(() => pending.delete(sessionKey));
}

export async function setChatAcpPermissionMode(
  state: ChatPageHost,
  mode: ChatAcpPermissionMode,
  sessionKey = state.sessionKey,
): Promise<boolean> {
  const current = readState(state, sessionKey);
  if (!current || current.pending) {
    return false;
  }
  if (
    !state.client ||
    !canCallGatewayMethod(gatewaySnapshot(state), CHAT_ACP_PERMISSIONS_SET_METHOD, "operator.write")
  ) {
    setChatError(state, t("chat.acpPermissions.failed", { reason: t("chat.handoff.offline") }));
    return false;
  }
  storeState(state, sessionKey, { ...current, pending: mode });
  try {
    await state.client.request(CHAT_ACP_PERMISSIONS_SET_METHOD, { sessionKey, mode });
    storeState(state, sessionKey, { ...current, mode, pending: undefined });
    return true;
  } catch (error) {
    storeState(state, sessionKey, { ...current, pending: undefined });
    setChatError(state, t("chat.acpPermissions.failed", { reason: String(error) }));
    return false;
  }
}

/** The toggle's props while an ACP agent is bound and its permission questions reach the chat. */
export function buildChatAcpPermissionToggle(params: {
  state: ChatPageHost;
  sessionKey: string;
  agentLabel: string | undefined;
  canWrite: boolean;
}): ChatAcpPermissionToggleProps | undefined {
  const { state, sessionKey } = params;
  const target = readChatHandoffInfo(state, sessionKey)?.binding?.targetSessionKey;
  if (!target || !params.agentLabel) {
    return undefined;
  }
  ensureChatAcpPermissions(state, sessionKey);
  const current = readState(state, sessionKey);
  if (!current || current.target !== target || !current.available) {
    return undefined;
  }
  return {
    agent: params.agentLabel,
    mode: current.pending ?? current.mode,
    pending: current.pending !== undefined,
    disabled: !params.canWrite,
    onSelect: (mode) => setChatAcpPermissionMode(state, mode, sessionKey),
  };
}
