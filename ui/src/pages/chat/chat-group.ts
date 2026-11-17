// Fork: group chat in an ordinary chat (see chat-group-registry.ts). Members live in the aiwb-groups plugin
// (`aiwb-groups.chat.*`); without it the buttons stay hidden and the chat works as before. A message naming
// members goes to them one by one instead of the chat's own answerer; anything else is sent as usual.
import { t } from "../../i18n/index.ts";
import { parseSlashCommand } from "../../lib/chat/commands.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import {
  draftAskingMember,
  parseChatGroupMentions,
  type ChatGroupController,
  type ChatGroupInfo,
  type ChatGroupMember,
  type ChatGroupTarget,
} from "./chat-group-registry.ts";
import type { ChatHandoffTarget } from "./chat-handoff-registry.ts";
import { setChatError } from "./chat-history-state.ts";
import { resolveAnswererIdentity } from "./chat-reply-identity.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { handleChatDraftChange } from "./input-history.ts";

export const CHAT_GROUP_METHODS = {
  get: "aiwb-groups.chat.get",
  add: "aiwb-groups.chat.add",
  remove: "aiwb-groups.chat.remove",
  ask: "aiwb-groups.chat.ask",
  stop: "aiwb-groups.chat.stop",
} as const;
const POLL_MS = 1_500;
const TURN_WAIT_MS = 16 * 60_000;

const infoByHost = new WeakMap<object, Map<string, ChatGroupInfo>>();
const pending = new WeakMap<object, Set<string>>();
const polling = new WeakMap<object, Set<string>>();

function gatewaySnapshot(state: ChatPageHost) {
  return {
    client: state.client,
    hello: state.hello,
    phase: state.connected ? ("connected" as const) : ("offline" as const),
  };
}

export function canUseChatGroups(state: ChatPageHost): boolean {
  return canCallGatewayMethod(gatewaySnapshot(state), CHAT_GROUP_METHODS.get, "operator.read");
}

export function readChatGroupInfo(state: ChatPageHost, sessionKey = state.sessionKey) {
  return infoByHost.get(state)?.get(sessionKey);
}

function readInfo(raw: unknown): ChatGroupInfo {
  const value = (raw ?? {}) as Partial<ChatGroupInfo>;
  return {
    members: Array.isArray(value.members) ? value.members : [],
    running: typeof value.running === "string" ? value.running : null,
    candidates: {
      agents: Array.isArray(value.candidates?.agents) ? value.candidates.agents : [],
      acpAgents: Array.isArray(value.candidates?.acpAgents) ? value.candidates.acpAgents : [],
    },
  };
}

function storeInfo(state: ChatPageHost, sessionKey: string, raw: unknown): ChatGroupInfo {
  const info = readInfo(raw);
  const map = infoByHost.get(state) ?? new Map<string, ChatGroupInfo>();
  infoByHost.set(state, map);
  map.set(sessionKey, info);
  state.requestUpdate?.();
  if (info.running) {
    pollWhileRunning(state, sessionKey);
  }
  return info;
}

async function request(state: ChatPageHost, method: string, params: Record<string, unknown>) {
  if (!state.client || !state.connected) {
    throw new Error(t("chat.handoff.offline"));
  }
  return await state.client.request<unknown>(method, params);
}

export async function refreshChatGroup(state: ChatPageHost, sessionKey = state.sessionKey) {
  if (!canUseChatGroups(state)) {
    return undefined;
  }
  try {
    return storeInfo(
      state,
      sessionKey,
      await request(state, CHAT_GROUP_METHODS.get, { sessionKey }),
    );
  } catch {
    return readChatGroupInfo(state, sessionKey);
  }
}

/** Loads a chat's members once; later reads follow the changes made here. */
export function ensureChatGroup(state: ChatPageHost, sessionKey = state.sessionKey) {
  const loading = pending.get(state) ?? new Set<string>();
  pending.set(state, loading);
  if (readChatGroupInfo(state, sessionKey) || loading.has(sessionKey) || !canUseChatGroups(state)) {
    return;
  }
  loading.add(sessionKey);
  void refreshChatGroup(state, sessionKey).finally(() => loading.delete(sessionKey));
}

/** While a member answers, re-read the chat's group state (its reply arrives as a chat row). */
function pollWhileRunning(state: ChatPageHost, sessionKey: string) {
  const active = polling.get(state) ?? new Set<string>();
  polling.set(state, active);
  if (active.has(sessionKey)) {
    return;
  }
  active.add(sessionKey);
  setTimeout(() => {
    active.delete(sessionKey);
    void refreshChatGroup(state, sessionKey);
  }, POLL_MS);
}

async function change(
  state: ChatPageHost,
  sessionKey: string,
  method: string,
  params: Record<string, unknown>,
  failure: string,
): Promise<boolean> {
  try {
    storeInfo(state, sessionKey, await request(state, method, { sessionKey, ...params }));
    return true;
  } catch (error) {
    setChatError(state, t(failure, { reason: String(error) }), true);
    return false;
  }
}

async function waitForMember(state: ChatPageHost, sessionKey: string) {
  const deadline = Date.now() + TURN_WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, POLL_MS);
    });
    const info = await refreshChatGroup(state, sessionKey);
    if (!info?.running) {
      return;
    }
  }
}

/** Asks each member in turn; the first ask writes the user's message into the chat. */
export async function askChatGroupMembers(
  state: ChatPageHost,
  members: readonly ChatGroupMember[],
  text: string,
  sessionKey = state.sessionKey,
): Promise<boolean> {
  for (const [index, member] of members.entries()) {
    const ok = await change(
      state,
      sessionKey,
      CHAT_GROUP_METHODS.ask,
      { member: member.key, text, record: index === 0 },
      "chat.group.askFailed",
    );
    if (!ok) {
      return false;
    }
    await waitForMember(state, sessionKey);
  }
  return true;
}

/**
 * A composer send that names group members goes to them instead of the chat's own answerer. Commands,
 * attachments, goals and messages naming nobody take the usual path (undefined).
 */
export function routeChatGroupSend(
  state: ChatPageHost,
  messageOverride: string | undefined,
  options: { intent?: unknown } | undefined,
): Promise<void> | undefined {
  const text = (messageOverride ?? state.chatMessage).trim();
  const members = readChatGroupInfo(state)?.members ?? [];
  if (
    !text ||
    members.length === 0 ||
    options?.intent ||
    parseSlashCommand(text) !== null ||
    (messageOverride === undefined && state.chatAttachments.length > 0)
  ) {
    return undefined;
  }
  const named = parseChatGroupMentions(text, members);
  if (named.length === 0) {
    return undefined;
  }
  if (messageOverride === undefined) {
    handleChatDraftChange(state, "");
    state.requestUpdate?.();
  }
  return askChatGroupMembers(state, named, text).then((ok) => {
    if (!ok && messageOverride === undefined && !state.chatMessage) {
      handleChatDraftChange(state, text);
      state.requestUpdate?.();
    }
  });
}

function memberTarget(kind: ChatGroupMember["kind"], id: string, label: string): ChatGroupTarget {
  return { member: { kind, id, name: label }, label };
}

export function createChatGroupController(
  state: ChatPageHost,
  params: { models: readonly ChatHandoffTarget[] },
): ChatGroupController {
  const sessionKey = state.sessionKey;
  ensureChatGroup(state, sessionKey);
  const info = readChatGroupInfo(state, sessionKey);
  const present = new Set(info?.members.map((member) => member.key) ?? []);
  const absent = (target: ChatGroupTarget) =>
    !present.has(`${target.member.kind}:${target.member.id}`);
  return {
    sessionKey,
    info,
    targets: {
      agents: (info?.candidates.agents ?? [])
        .map((agent) => memberTarget("agent", agent.id, agent.name || agent.id))
        .filter(absent),
      acpAgents: (info?.candidates.acpAgents ?? [])
        .map((agent) =>
          memberTarget("acp", agent, resolveAnswererIdentity({ kind: "agent", agent }).name),
        )
        .filter(absent),
      models: info
        ? params.models
            .flatMap((target) =>
              target.answerer.kind === "model"
                ? [memberTarget("model", target.answerer.model, target.label)]
                : [],
            )
            .filter(absent)
        : [],
    },
    busy: Boolean(info?.running),
    add: async (target) =>
      await change(
        state,
        sessionKey,
        CHAT_GROUP_METHODS.add,
        { member: target.member },
        "chat.group.addFailed",
      ),
    remove: async (key) =>
      await change(
        state,
        sessionKey,
        CHAT_GROUP_METHODS.remove,
        { member: key },
        "chat.group.removeFailed",
      ),
    ask: (member) => {
      handleChatDraftChange(
        state,
        draftAskingMember(state.chatMessage, member, info?.members ?? []),
      );
      state.requestUpdate?.();
    },
    stop: async () => {
      try {
        await request(state, CHAT_GROUP_METHODS.stop, { sessionKey });
      } catch (error) {
        setChatError(state, t("chat.group.stopFailed", { reason: String(error) }), true);
      }
      await refreshChatGroup(state, sessionKey);
    },
  };
}
