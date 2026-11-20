// Fork: each reply shows the participant that wrote it. An ACP agent's reply (provider "acp",
// model "<agent>") gets that agent's own name and avatar, as a separate participant would; a
// model's reply names the model. ACP agent identities come from the ACPX plugin config
// (`agentIdentities.<agent>`: name, emoji, avatar) through `acpx.chat.handoff.get`; an agent
// without one gets the generated agent face for its own id, so two agents never look alike.
import { createSignal } from "solid-js";
import { formatAgentLabel, type ChatAnswerer } from "./chat-handoff-registry.ts";
import { messageAuthor, messageParticipant } from "./chat-reply-authors.ts";

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
// Model display names from every chat pane's catalog, merged: two panes (split view) publishing their own labeler
// in turn re-rendered each other without end.
const modelLabels = new Map<string, string>();
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

/**
 * A chat pane publishes the model names of its catalog ([model ref or id, name]), shared by every reply. Only a name
 * that is new or changed re-renders the replies, so panes publishing the same catalog stay quiet.
 */
export function publishReplyModelLabels(entries: Iterable<readonly [string, string]>): void {
  // One name per model in a publish: a bare model id shared by several providers with different names
  // (`anthropic/x` "X", `openrouter/x` "X (OpenRouter)") would otherwise flip on every publish and re-render
  // the replies without end. The first name wins.
  const next = new Map<string, string>();
  for (const [model, name] of entries) {
    if (name && !next.has(model)) {
      next.set(model, name);
    }
  }
  let changed = false;
  for (const [model, name] of next) {
    if (modelLabels.get(model) !== name) {
      modelLabels.set(model, name);
      changed = true;
    }
  }
  if (changed) {
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
  const label = modelLabels.get(answerer.model);
  return {
    kind: "model",
    model: answerer.model,
    name: label || answerer.model.split("/").pop() || answerer.model,
  };
}

/**
 * Fork: a group chat member's reply. An OpenClaw agent shows its own avatar and name, a model the
 * name it was added under; an ACP agent keeps its configured identity.
 */
function participantIdentity(message: unknown): ReplyIdentity | undefined {
  const participant = messageParticipant(message);
  if (!participant || participant.kind === "acp") {
    return undefined;
  }
  if (participant.kind === "agent") {
    return {
      kind: "agent",
      agent: participant.id,
      avatarId: participant.id,
      name: participant.name,
      avatar: null,
      textAvatar: null,
    };
  }
  return { kind: "model", model: participant.id, name: participant.name };
}

/** The identity of the first message in `messages` that names its author. */
export function resolveReplyIdentity(
  messages: ReadonlyArray<{ message: unknown }>,
): ReplyIdentity | undefined {
  for (const { message } of messages) {
    const member = participantIdentity(message);
    if (member) {
      return member;
    }
    const author = messageAuthor(message);
    if (author) {
      return resolveAnswererIdentity(author);
    }
  }
  return undefined;
}

/** The ACP agent that wrote `message`, for splitting assistant groups by author. */
export function replyAuthorKey(message: unknown): string | null {
  const participant = messageParticipant(message);
  if (participant) {
    return `participant:${participant.key}`;
  }
  const author = messageAuthor(message);
  return author ? JSON.stringify(author) : null;
}
