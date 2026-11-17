// Fork: each reply shows the participant that wrote it. An ACP agent's reply (provider "acp",
// model "<agent>") gets that agent's own name and avatar, as a separate participant would; a
// model's reply names the model. ACP agent identities come from the ACPX plugin config
// (`agentIdentities.<agent>`: name, emoji, avatar) through `acpx.chat.handoff.get`; an agent
// without one gets the generated agent face for its own id, so two agents never look alike.
import { createSignal } from "solid-js";
import { formatAgentLabel, type ChatAnswerer } from "./chat-handoff-registry.ts";
import { messageAuthor } from "./chat-reply-authors.ts";

export type AcpAgentIdentity = { name?: string; emoji?: string; avatar?: string };

/** What a reply's avatar and sender name show. */
export type ReplyIdentity =
  | {
      kind: "agent";
      agent: string;
      /** Avatar id: "acp:<agent>", so an OpenClaw agent of the same id keeps its own face. */
      avatarId: string;
      name: string;
      avatar: string | null;
      textAvatar: string | null;
    }
  | { kind: "model"; model: string; name: string };

// Plain values read the latest write at once; the version signal lets Solid readers re-render.
let acpIdentities: ReadonlyMap<string, AcpAgentIdentity> = new Map();
let modelLabeler: ((model: string) => string) | undefined;
const [identityVersion, setIdentityVersion] = createSignal(0);
const bump = () => setIdentityVersion((version) => version + 1);

function readText(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.trim() && value.trim().length <= max
    ? value.trim()
    : undefined;
}

/** Merges identities reported by the Gateway; unchanged input keeps the signal quiet. */
export function publishAcpAgentIdentities(raw: unknown): void {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return;
  }
  const next = new Map(acpIdentities);
  let changed = false;
  for (const [agent, value] of Object.entries(raw as Record<string, unknown>)) {
    const entry = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
    const identity: AcpAgentIdentity = {
      ...(readText(entry.name, 64) ? { name: readText(entry.name, 64) } : {}),
      ...(readText(entry.emoji, 8) ? { emoji: readText(entry.emoji, 8) } : {}),
      ...(readText(entry.avatar, 2_000_000) ? { avatar: readText(entry.avatar, 2_000_000) } : {}),
    };
    if (JSON.stringify(next.get(agent)) !== JSON.stringify(identity)) {
      next.set(agent, identity);
      changed = true;
    }
  }
  if (changed) {
    acpIdentities = next;
    bump();
  }
}

/** The chat page publishes how it labels models (catalog names), shared by every reply. */
export function publishReplyModelLabeler(labeler: (model: string) => string): void {
  if (modelLabeler !== labeler) {
    modelLabeler = labeler;
    // Published while the chat pane renders; re-render the replies after it, not inside it.
    queueMicrotask(bump);
  }
}

export function resolveAnswererIdentity(answerer: ChatAnswerer): ReplyIdentity {
  void identityVersion();
  if (answerer.kind === "agent") {
    const configured = acpIdentities.get(answerer.agent);
    return {
      kind: "agent",
      agent: answerer.agent,
      avatarId: `acp:${answerer.agent}`,
      name: configured?.name ?? formatAgentLabel(answerer.agent),
      avatar: configured?.avatar ?? null,
      textAvatar: configured?.emoji ?? null,
    };
  }
  const label = modelLabeler?.(answerer.model);
  return {
    kind: "model",
    model: answerer.model,
    name: label || answerer.model.split("/").pop() || answerer.model,
  };
}

/** The identity of the first message in `messages` that names its author. */
export function resolveReplyIdentity(
  messages: ReadonlyArray<{ message: unknown }>,
): ReplyIdentity | undefined {
  for (const { message } of messages) {
    const author = messageAuthor(message);
    if (author) {
      return resolveAnswererIdentity(author);
    }
  }
  return undefined;
}

/** The ACP agent that wrote `message`, for splitting assistant groups by author. */
export function replyAuthorKey(message: unknown): string | null {
  const author = messageAuthor(message);
  return author ? JSON.stringify(author) : null;
}
