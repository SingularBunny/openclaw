// Fork: the chat handoff controller each chat pane publishes for its message actions, failure
// buttons and composer chip (see chat-handoff.ts). Kept free of chat-state imports.
import { createSignal } from "solid-js";
import type { RefusalSignal } from "../../../../src/shared/refusal-signal.js";

export type ChatAnswerer =
  | { kind: "model"; model: string; agentRuntime?: string }
  | { kind: "agent"; agent: string };

export type ChatHandoffRecord = { previous: ChatAnswerer; current: ChatAnswerer; at: number };

export type ChatHandoffInfo = {
  binding: { agent: string; targetSessionKey: string } | null;
  handoff: ChatHandoffRecord | null;
  agents: string[];
};

export type ChatHandoffTarget = { answerer: ChatAnswerer; label: string; provider?: string };

/** What a chat's message actions, error buttons and chip need; published by the chat pane. */
export type ChatHandoffController = {
  sessionKey: string;
  current: ChatAnswerer | undefined;
  /** Who answered before the last handoff (or the session model while an agent is bound). */
  previous: ChatAnswerer | undefined;
  info: ChatHandoffInfo | undefined;
  models: readonly ChatHandoffTarget[];
  agents: readonly ChatHandoffTarget[];
  /** The prompt exceeds the size above which a switch loses the provider's prompt cache. */
  longContext: boolean;
  busy: boolean;
  labelOf: (answerer: ChatAnswerer) => string;
  /**
   * `refusal` (fork, I14): handed off from the refusal hint; the Gateway logs it and leaves the
   * refused turn out of the model context before the question is re-sent.
   */
  handOff: (
    target: ChatAnswerer,
    opts?: { resendBefore?: string; refusal?: RefusalSignal },
  ) => Promise<boolean>;
  returnToPrevious: () => Promise<boolean>;
  dismiss: () => void;
  retry: (failedMessageKey?: string) => void;
  chooseAnotherModel: (failedMessageKey?: string) => void;
};

const controllers = new Map<string, ChatHandoffController>();
const [controllerVersion, setControllerVersion] = createSignal(0);
const controllerSignatures = new Map<string, string>();

/** Solid readers track this, so actions update when the chat publishes a new state. */
export function readChatHandoffController(sessionKey: string | undefined) {
  void controllerVersion();
  return sessionKey ? controllers.get(sessionKey) : undefined;
}

export function publishChatHandoffController(controller: ChatHandoffController): void {
  controllers.set(controller.sessionKey, controller);
  const signature = JSON.stringify([
    controller.current,
    controller.info,
    controller.models.length,
    controller.agents.map((agent) => agent.label),
    controller.longContext,
    controller.busy,
  ]);
  if (controllerSignatures.get(controller.sessionKey) !== signature) {
    controllerSignatures.set(controller.sessionKey, signature);
    setControllerVersion((version) => version + 1);
  }
}

export function sameChatAnswerer(left?: ChatAnswerer | null, right?: ChatAnswerer | null) {
  if (!left || !right || left.kind !== right.kind) {
    return false;
  }
  return left.kind === "agent"
    ? left.agent === (right as { agent: string }).agent
    : left.model === (right as { model: string }).model;
}

export function formatAgentLabel(agent: string): string {
  return agent ? agent.charAt(0).toUpperCase() + agent.slice(1) : agent;
}

/**
 * The author of a stored assistant reply: the agent name for an ACP reply (provider "acp",
 * model "<agent>"), else the model id without its provider. Gateway rows have no author.
 */
export function formatReplyAuthor(provider: unknown, model: unknown): string | undefined {
  const modelId = typeof model === "string" ? model.trim() : "";
  if (!modelId || provider === "openclaw" || modelId === "gateway-injected") {
    return undefined;
  }
  return provider === "acp" ? formatAgentLabel(modelId) : modelId.split("/").pop() || modelId;
}

const [refusalHandoffs, setRefusalHandoffs] = createSignal<ReadonlySet<string>>(new Set());

/** Fork (I14): a reply handed off from its refusal hint hides the hint at once. */
export function markRefusalHandedOff(messageKey: string): void {
  setRefusalHandoffs((current) => new Set([...current, messageKey]));
}

export function isRefusalHandedOff(messageKey: string | undefined): boolean {
  return messageKey !== undefined && refusalHandoffs().has(messageKey);
}
