import type { RefusalSignal } from "../../../../src/shared/refusal-signal.js";
// Fork: switching who answers a chat by buttons. A chat is answered by a model (its session model)
// or, while bound with `/acp spawn <agent> --bind here`, by an ACP agent. Handing off runs the same
// steps as the slash commands (`/acp close`, sessions.patch model, `/acp spawn ... --bind here`),
// records who answered before through the ACPX gateway methods, and can re-send the last user
// message so the new model or agent answers it with the chat history. Nothing is provider-specific.
import { t } from "../../i18n/index.ts";
import { extractText } from "../../lib/chat/message-extract.ts";
import { resolveChatModelOverrideValue } from "../../lib/chat/model-select-state.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import {
  markRefusalHandedOff,
  sameChatAnswerer,
  type ChatAnswerer,
  type ChatHandoffController,
  type ChatHandoffInfo,
  type ChatHandoffTarget,
} from "./chat-handoff-registry.ts";
import { setChatError } from "./chat-history-state.ts";
import { lastOtherReplyAnswerer, transcriptNamesAuthors } from "./chat-reply-authors.ts";
import {
  publishAcpAgentIdentities,
  publishReplyModelLabeler,
  resolveAnswererIdentity,
} from "./chat-reply-identity.ts";
import { switchChatModel } from "./chat-session.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { selectedChatSessionRow } from "./chat-state-route.ts";
import { persistedMessageEntryId } from "./chat-thread-items.ts";

export {
  formatAgentLabel,
  isRefusalHandedOff,
  publishChatHandoffController,
  readChatHandoffController,
  sameChatAnswerer,
} from "./chat-handoff-registry.ts";
export type {
  ChatAnswerer,
  ChatHandoffController,
  ChatHandoffInfo,
  ChatHandoffRecord,
  ChatHandoffTarget,
} from "./chat-handoff-registry.ts";

export const CHAT_HANDOFF_AGENT_GROUP_ID = "acpAgents";
export const CHAT_HANDOFF_GET_METHOD = "acpx.chat.handoff.get";
export const CHAT_HANDOFF_SET_METHOD = "acpx.chat.handoff.set";
/** Above this many prompt tokens a switch re-reads the whole chat without a warm cache. */
export const CHAT_HANDOFF_LONG_CONTEXT_TOKENS = 100_000;
const IDLE_WAIT_MS = 120_000;
const IDLE_POLL_MS = 100;

const infoByHost = new WeakMap<object, Map<string, ChatHandoffInfo>>();
const pendingInfo = new WeakMap<object, Set<string>>();
const pendingResend = new WeakMap<object, Map<string, string>>();

function gatewaySnapshot(state: ChatPageHost) {
  return {
    client: state.client,
    hello: state.hello,
    phase: state.connected ? ("connected" as const) : ("offline" as const),
  };
}

export function canUseChatHandoff(state: ChatPageHost): boolean {
  return canCallGatewayMethod(gatewaySnapshot(state), CHAT_HANDOFF_GET_METHOD, "operator.read");
}

export function readChatHandoffInfo(state: ChatPageHost, sessionKey: string) {
  return infoByHost.get(state)?.get(sessionKey);
}

function storeInfo(state: ChatPageHost, sessionKey: string, info: ChatHandoffInfo) {
  const map = infoByHost.get(state) ?? new Map<string, ChatHandoffInfo>();
  infoByHost.set(state, map);
  map.set(sessionKey, info);
}

export async function refreshChatHandoffInfo(
  state: ChatPageHost,
  sessionKey = state.sessionKey,
): Promise<ChatHandoffInfo | undefined> {
  if (!state.client || !canUseChatHandoff(state)) {
    return undefined;
  }
  try {
    const result = await state.client.request<Partial<ChatHandoffInfo> & { identities?: unknown }>(
      CHAT_HANDOFF_GET_METHOD,
      { sessionKey },
    );
    publishAcpAgentIdentities(result?.identities);
    const info: ChatHandoffInfo = {
      binding: result?.binding ?? null,
      handoff: result?.handoff ?? null,
      agents: Array.isArray(result?.agents) ? result.agents : [],
    };
    storeInfo(state, sessionKey, info);
    state.requestUpdate?.();
    return info;
  } catch {
    return readChatHandoffInfo(state, sessionKey);
  }
}

/** Loads the chat's binding once per session; later reads follow the switches made here. */
export function ensureChatHandoffInfo(state: ChatPageHost, sessionKey = state.sessionKey) {
  const pending = pendingInfo.get(state) ?? new Set<string>();
  pendingInfo.set(state, pending);
  if (readChatHandoffInfo(state, sessionKey) || pending.has(sessionKey)) {
    return;
  }
  pending.add(sessionKey);
  void refreshChatHandoffInfo(state, sessionKey).finally(() => pending.delete(sessionKey));
}

export const CHAT_HANDOFF_AGENT_MODEL_GROUP_ID = "acpAgentModels";
export const CHAT_ACP_MODELS_GET_METHOD = "acpx.chat.models.get";
export const CHAT_ACP_MODELS_SET_METHOD = "acpx.chat.models.set";

/** The bound ACP agent's models (`/acp model` by button), per chat and bound ACP session. */
export type ChatAcpModelsState = {
  target: string;
  status: "loading" | "ready" | "error";
  current: string | null;
  models: { id: string; name?: string }[];
  error?: string;
};

const acpModelsByHost = new WeakMap<object, Map<string, ChatAcpModelsState>>();

export function canUseChatAcpModels(state: ChatPageHost): boolean {
  return canCallGatewayMethod(gatewaySnapshot(state), CHAT_ACP_MODELS_GET_METHOD, "operator.read");
}

export function readChatAcpModels(state: ChatPageHost, sessionKey = state.sessionKey) {
  return acpModelsByHost.get(state)?.get(sessionKey);
}

function storeAcpModels(state: ChatPageHost, sessionKey: string, value: ChatAcpModelsState) {
  const map = acpModelsByHost.get(state) ?? new Map<string, ChatAcpModelsState>();
  acpModelsByHost.set(state, map);
  map.set(sessionKey, value);
  state.requestUpdate?.();
}

export async function refreshChatAcpModels(
  state: ChatPageHost,
  sessionKey = state.sessionKey,
): Promise<ChatAcpModelsState | undefined> {
  const target = readChatHandoffInfo(state, sessionKey)?.binding?.targetSessionKey;
  if (!state.client || !target || !canUseChatAcpModels(state)) {
    return undefined;
  }
  const previous = readChatAcpModels(state, sessionKey);
  if (!previous || previous.target !== target) {
    storeAcpModels(state, sessionKey, { target, status: "loading", current: null, models: [] });
  }
  try {
    const result = await state.client.request<{
      models?: { current?: unknown; models?: unknown } | null;
    }>(CHAT_ACP_MODELS_GET_METHOD, { sessionKey });
    const models = Array.isArray(result?.models?.models)
      ? (result.models.models as unknown[]).flatMap((entry) => {
          const item = entry as { id?: unknown; name?: unknown } | null;
          return typeof item?.id === "string"
            ? [{ id: item.id, ...(typeof item.name === "string" ? { name: item.name } : {}) }]
            : [];
        })
      : [];
    const current = typeof result?.models?.current === "string" ? result.models.current : null;
    storeAcpModels(state, sessionKey, { target, status: "ready", current, models });
  } catch (error) {
    storeAcpModels(state, sessionKey, {
      target,
      status: "error",
      current: previous?.current ?? null,
      models: previous?.models ?? [],
      error: String(error),
    });
  }
  return readChatAcpModels(state, sessionKey);
}

const pendingAcpModels = new WeakMap<object, Set<string>>();

/** Loads the bound agent's models once per bound ACP session. */
export function ensureChatAcpModels(state: ChatPageHost, sessionKey = state.sessionKey) {
  const target = readChatHandoffInfo(state, sessionKey)?.binding?.targetSessionKey;
  const pending = pendingAcpModels.get(state) ?? new Set<string>();
  pendingAcpModels.set(state, pending);
  const key = `${sessionKey}\u0000${target}`;
  if (!target || readChatAcpModels(state, sessionKey)?.target === target || pending.has(key)) {
    return;
  }
  pending.add(key);
  void refreshChatAcpModels(state, sessionKey).finally(() => pending.delete(key));
}

/** Sets the bound agent's model, as `/acp model <id>` does; the reason lands in the chat error. */
export async function setChatAcpModel(
  state: ChatPageHost,
  model: string,
  sessionKey = state.sessionKey,
): Promise<boolean> {
  if (
    !state.client ||
    !canCallGatewayMethod(gatewaySnapshot(state), CHAT_ACP_MODELS_SET_METHOD, "operator.write")
  ) {
    setChatError(
      state,
      t("chat.handoff.agentModelFailed", { model, reason: t("chat.handoff.offline") }),
    );
    return false;
  }
  try {
    await state.client.request(CHAT_ACP_MODELS_SET_METHOD, { sessionKey, model });
    await refreshChatAcpModels(state, sessionKey);
    return true;
  } catch (error) {
    setChatError(state, t("chat.handoff.agentModelFailed", { model, reason: String(error) }));
    return false;
  }
}

/** The session's selected model (its override, else the row's resolved model). */
export function currentChatModel(state: ChatPageHost, sessionKey = state.sessionKey): string {
  const row = selectedChatSessionRow(state);
  return (
    resolveChatModelOverrideValue({
      activeSession: row,
      chatModelCatalog: state.chatModelCatalog,
      modelOverrides: state.sessions.state.modelOverrides,
      sessionKey,
      sessionsResult: state.sessionsResult ?? null,
    }) ||
    (state.sessionsResult?.defaults?.modelProvider && state.sessionsResult.defaults.model
      ? `${state.sessionsResult.defaults.modelProvider}/${state.sessionsResult.defaults.model}`
      : (state.sessionsResult?.defaults?.model ?? ""))
  );
}

export function currentChatAnswerer(
  state: ChatPageHost,
  sessionKey = state.sessionKey,
): ChatAnswerer | undefined {
  const binding = readChatHandoffInfo(state, sessionKey)?.binding;
  if (binding) {
    return { kind: "agent", agent: binding.agent };
  }
  const model = currentChatModel(state, sessionKey);
  return model ? { kind: "model", model } : undefined;
}

/**
 * Who answered before `target` takes over: the last answerer other than `target` that produced a
 * reply in the transcript (a model that failed or was stopped never counts). Null when the
 * transcript names authors and nobody else answered; `fallback` (who answered before the switch)
 * when it names none, as in a transcript written before replies carried their author.
 */
export function previousReplyAnswerer(
  state: ChatPageHost,
  target: ChatAnswerer,
  fallback: ChatAnswerer,
): ChatAnswerer | null {
  const messages = state.chatMessages;
  if (!transcriptNamesAuthors(messages)) {
    return fallback;
  }
  return lastOtherReplyAnswerer(messages, target, state.chatModelCatalog ?? []) ?? null;
}

export function chatModelLabel(state: ChatPageHost, model: string): string {
  const entry = state.chatModelCatalog?.find(
    (candidate) => `${candidate.provider}/${candidate.id}` === model || candidate.id === model,
  );
  return entry?.name?.trim() || model.split("/").pop() || model;
}

export function chatAnswererLabel(state: ChatPageHost, answerer: ChatAnswerer): string {
  return answerer.kind === "agent"
    ? resolveAnswererIdentity(answerer).name
    : chatModelLabel(state, answerer.model);
}

const modelLabelers = new WeakMap<object, (model: string) => string>();

/** Reply sender names use the picker's model labels (fork: who wrote each reply). */
function publishModelLabels(state: ChatPageHost) {
  let labeler = modelLabelers.get(state);
  if (!labeler) {
    labeler = (model) => chatModelLabel(state, model);
    modelLabelers.set(state, labeler);
  }
  publishReplyModelLabeler(labeler);
}

function chatIdle(state: ChatPageHost): boolean {
  return !state.chatSending && !state.chatRunId && state.chatStream === null;
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Waits until the chat finished the turn a command or message started. */
export async function waitForChatIdle(state: ChatPageHost, timeoutMs = IDLE_WAIT_MS) {
  const deadline = Date.now() + timeoutMs;
  // Let the submitted turn register before reading idleness.
  await sleep(IDLE_POLL_MS);
  while (!chatIdle(state)) {
    if (Date.now() > deadline) {
      return false;
    }
    await sleep(IDLE_POLL_MS);
  }
  return true;
}

async function sendChatCommand(state: ChatPageHost, command: string): Promise<boolean> {
  await state.handleSendChat(command);
  return await waitForChatIdle(state);
}

async function recordHandoff(
  state: ChatPageHost,
  sessionKey: string,
  record: { previous: ChatAnswerer; current: ChatAnswerer } | null,
) {
  const info = readChatHandoffInfo(state, sessionKey) ?? {
    binding: null,
    handoff: null,
    agents: [],
  };
  storeInfo(state, sessionKey, {
    ...info,
    handoff: record ? { ...record, at: Date.now() } : null,
  });
  state.requestUpdate?.();
  if (
    !state.client ||
    !canCallGatewayMethod(gatewaySnapshot(state), CHAT_HANDOFF_SET_METHOD, "operator.write")
  ) {
    return;
  }
  try {
    await state.client.request(CHAT_HANDOFF_SET_METHOD, {
      sessionKey,
      previous: record?.previous ?? null,
      current: record?.current ?? null,
    });
  } catch {
    // The chip keeps the local record; the next load reads whatever the Gateway kept.
  }
}

/** The text of the user message a reply answered (the last user message before it). */
export function findPromptBefore(
  messages: readonly unknown[],
  messageKey?: string,
): string | undefined {
  let end = messages.length;
  if (messageKey) {
    const index = messages.findIndex((message) => persistedMessageEntryId(message) === messageKey);
    if (index >= 0) {
      end = index;
    }
  }
  for (let index = end - 1; index >= 0; index -= 1) {
    const message = messages[index] as { role?: unknown } | null;
    if (message?.role === "user") {
      const text = extractText(message)?.trim();
      // Upstream's Try again sends a "continue" prompt; Retry re-sends the question before it.
      if (text && !text.startsWith("/") && text !== t("chat.recovery.continuePrompt")) {
        return text;
      }
    }
  }
  return undefined;
}

/**
 * Hands the chat to `target`: unbinds a bound agent first (`/acp close`), then sets the model or
 * binds the agent (`/acp spawn <agent> --bind here`), records the handoff and re-sends `resend`.
 * A failed step leaves the command's own reply in the chat and adds the reason as the chat error.
 */
export async function handOffChat(
  state: ChatPageHost,
  target: ChatAnswerer,
  opts: { resend?: string; record?: "handoff" | "clear" } = {},
): Promise<boolean> {
  const sessionKey = state.sessionKey;
  const label = chatAnswererLabel(state, target);
  const fail = (reason: string) => {
    setChatError(state, t("chat.handoff.failed", { target: label, reason }));
    return false;
  };
  if (!state.client || !state.connected) {
    return fail(t("chat.handoff.offline"));
  }
  const info = readChatHandoffInfo(state, sessionKey) ?? (await refreshChatHandoffInfo(state));
  const previous = currentChatAnswerer(state, sessionKey);
  if (!sameChatAnswerer(previous, target)) {
    if (info?.binding && !(target.kind === "agent" && info.binding.agent === target.agent)) {
      await sendChatCommand(state, "/acp close");
      const after = await refreshChatHandoffInfo(state, sessionKey);
      if (after?.binding) {
        return fail(
          t("chat.handoff.closeFailed", {
            agent: resolveAnswererIdentity({ kind: "agent", agent: after.binding.agent }).name,
          }),
        );
      }
    }
    if (target.kind === "agent") {
      if (info && info.agents.length > 0 && !info.agents.includes(target.agent)) {
        return fail(t("chat.handoff.agentNotAllowed", { agent: target.agent }));
      }
      await sendChatCommand(state, `/acp spawn ${target.agent} --bind here`);
      const after = await refreshChatHandoffInfo(state, sessionKey);
      if (after?.binding?.agent !== target.agent) {
        return fail(t("chat.handoff.bindFailed"));
      }
    } else if (currentChatModel(state, sessionKey) !== target.model) {
      const switched = await switchChatModel(state, target.model, sessionKey, target.agentRuntime);
      if (!switched) {
        return fail(t("chat.handoff.modelFailed"));
      }
    }
    if (previous) {
      const before =
        opts.record === "clear" ? null : previousReplyAnswerer(state, target, previous);
      await recordHandoff(state, sessionKey, before ? { previous: before, current: target } : null);
    }
  }
  if (opts.resend && state.sessionKey === sessionKey) {
    await waitForChatIdle(state);
    await state.handleSendChat(opts.resend);
  }
  return true;
}

export const CHAT_REFUSAL_HANDOFF_METHOD = "chat.refusal.handoff";

/**
 * Fork (I14): handing off from the refusal hint. The Gateway writes a log line and leaves the
 * refused turn (its question and reply) out of the model context, so the next model gets the
 * question once, as the re-sent message, and never the refused answer. The rows stay visible.
 * Without the method (an older Gateway) the hand-off still runs and the error says so.
 */
export async function recordRefusalHandoff(
  state: ChatPageHost,
  sessionKey: string,
  params: { messageId: string; signal: RefusalSignal; target: string },
): Promise<boolean> {
  markRefusalHandedOff(params.messageId);
  if (
    !state.client ||
    !canCallGatewayMethod(gatewaySnapshot(state), CHAT_REFUSAL_HANDOFF_METHOD, "operator.write")
  ) {
    const reason = state.client ? t("chat.handoff.refusalUnsupported") : t("chat.handoff.offline");
    setChatError(state, t("chat.handoff.refusalNotExcluded", { reason }));
    return false;
  }
  try {
    await state.client.request(CHAT_REFUSAL_HANDOFF_METHOD, { sessionKey, ...params });
    return true;
  } catch (error) {
    setChatError(state, t("chat.handoff.refusalNotExcluded", { reason: String(error) }));
    return false;
  }
}

/** A plain model switch in the picker is a handoff too, so the chip can switch back. */
export async function recordChatPickerSwitch(
  state: ChatPageHost,
  sessionKey: string,
  previous: ChatAnswerer | undefined,
  model: string,
) {
  const current: ChatAnswerer = { kind: "model", model };
  if (previous && !sameChatAnswerer(previous, current)) {
    const before = previousReplyAnswerer(state, current, previous);
    await recordHandoff(state, sessionKey, before ? { previous: before, current } : null);
  }
}

/** Every catalog model, labelled as in the picker, as a handoff target. */
export function listChatHandoffModels(state: ChatPageHost): ChatHandoffTarget[] {
  return (state.chatModelCatalog ?? []).map((entry) => ({
    answerer: { kind: "model", model: `${entry.provider}/${entry.id}` },
    label: entry.name?.trim() || entry.id,
    provider: entry.provider,
  }));
}

/** Remembers a failed turn's prompt for the next choice in the model picker. */
export function setPendingResend(
  state: ChatPageHost,
  sessionKey: string,
  text: string | undefined,
) {
  const map = pendingResend.get(state) ?? new Map<string, string>();
  pendingResend.set(state, map);
  if (text) {
    map.set(sessionKey, text);
  } else {
    map.delete(sessionKey);
  }
}

export function takePendingResend(state: ChatPageHost, sessionKey: string): string | undefined {
  const text = pendingResend.get(state)?.get(sessionKey);
  pendingResend.get(state)?.delete(sessionKey);
  return text;
}

export function createChatHandoffController(
  state: ChatPageHost,
  params: { models: readonly ChatHandoffTarget[] },
): ChatHandoffController {
  const sessionKey = state.sessionKey;
  ensureChatHandoffInfo(state, sessionKey);
  publishModelLabels(state);
  const info = readChatHandoffInfo(state, sessionKey);
  const row = selectedChatSessionRow(state);
  const agents = (info?.agents ?? []).map((agent): ChatHandoffTarget => ({
    answerer: { kind: "agent", agent },
    label: resolveAnswererIdentity({ kind: "agent", agent }).name,
  }));
  const current = currentChatAnswerer(state, sessionKey);
  const sessionModel = currentChatModel(state, sessionKey);
  // A recorded switch shows the chip; the transcript names who really answered before (I13 fix:
  // a model that failed after the switch is skipped). A bound agent can always unbind.
  const previous =
    info?.handoff && sameChatAnswerer(info.handoff.current, current)
      ? (lastOtherReplyAnswerer(state.chatMessages, current, state.chatModelCatalog ?? []) ??
        info.handoff.previous)
      : info?.binding && sessionModel
        ? ({ kind: "model", model: sessionModel } as const)
        : undefined;
  return {
    sessionKey,
    current,
    previous,
    info,
    models: params.models,
    agents,
    longContext: (row?.totalTokens ?? 0) > CHAT_HANDOFF_LONG_CONTEXT_TOKENS,
    busy: !chatIdle(state),
    labelOf: (answerer) => chatAnswererLabel(state, answerer),
    handOff: async (target, opts) => {
      const resend = findPromptBefore(state.chatMessages, opts?.resendBefore);
      if (opts?.refusal && opts.resendBefore) {
        await recordRefusalHandoff(state, sessionKey, {
          messageId: opts.resendBefore,
          signal: opts.refusal,
          target: chatAnswererLabel(state, target),
        });
      }
      return await handOffChat(state, target, { resend });
    },
    // Bound without a recorded handoff (a typed /acp spawn), returning unbinds to the session model.
    returnToPrevious: async () =>
      previous ? await handOffChat(state, previous, { record: "clear" }) : false,
    dismiss: () => void recordHandoff(state, sessionKey, null),
    retry: (failedMessageKey) => {
      const prompt = findPromptBefore(state.chatMessages, failedMessageKey);
      if (prompt) {
        void state.handleSendChat(prompt);
      }
    },
    chooseAnotherModel: (failedMessageKey) => {
      setPendingResend(state, sessionKey, findPromptBefore(state.chatMessages, failedMessageKey));
      state.chatModelPickerOpenSessionKey = sessionKey;
      state.requestUpdate?.();
    },
  };
}
