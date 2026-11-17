// Fork: group chat in an ordinary chat. Besides the chat's own answerer (switched by Hand off), members added
// with "Add to group chat" (an OpenClaw agent, an ACP agent or a model) answer as separate participants when a
// message names them: "@Junie …" or the "Ask Junie" chip. The aiwb-groups plugin runs their turns and writes their
// replies into the chat. The controller each chat pane publishes for the chip strip and the add menus lives here,
// free of chat-state imports.
import { createSignal } from "solid-js";
import { areUiSessionKeysEquivalent } from "../../lib/sessions/session-key.ts";

export type ChatGroupMemberKind = "agent" | "acp" | "model";

export type ChatGroupMember = { kind: ChatGroupMemberKind; id: string; name: string; key: string };

export type ChatGroupInfo = {
  members: ChatGroupMember[];
  /** The member whose turn is running, by key. */
  running: string | null;
  candidates: { agents: { id: string; name: string }[]; acpAgents: string[] };
};

export type ChatGroupTarget = { member: Omit<ChatGroupMember, "key">; label: string };

export type ChatGroupController = {
  sessionKey: string;
  info: ChatGroupInfo | undefined;
  /** Who can be added, grouped as the menus show them (members already in the chat excluded). */
  targets: { agents: ChatGroupTarget[]; acpAgents: ChatGroupTarget[]; models: ChatGroupTarget[] };
  busy: boolean;
  add: (target: ChatGroupTarget) => Promise<boolean>;
  remove: (key: string) => Promise<boolean>;
  /** "Ask <name>": puts "@<name> " at the start of the composer draft. */
  ask: (member: ChatGroupMember) => void;
  stop: () => Promise<void>;
};

const controllers = new Map<string, ChatGroupController>();
const signatures = new Map<string, string>();
const [version, setVersion] = createSignal(0);

/** The chat's controller; the header passes the session row's key, which may be the canonical form. */
export function readChatGroupController(sessionKey: string | undefined) {
  void version();
  if (!sessionKey) {
    return undefined;
  }
  return (
    controllers.get(sessionKey) ??
    [...controllers.values()].find((controller) =>
      areUiSessionKeysEquivalent(controller.sessionKey, sessionKey),
    )
  );
}

export function publishChatGroupController(controller: ChatGroupController): void {
  controllers.set(controller.sessionKey, controller);
  const signature = JSON.stringify([
    controller.info,
    controller.busy,
    controller.targets.models.length,
    controller.targets.agents.map((target) => target.label),
    controller.targets.acpAgents.map((target) => target.label),
  ]);
  if (signatures.get(controller.sessionKey) !== signature) {
    signatures.set(controller.sessionKey, signature);
    // Published while the chat pane renders; re-render the group buttons after it, not inside it.
    queueMicrotask(() => setVersion((value) => value + 1));
  }
}

function handles(member: ChatGroupMember): string[] {
  const short = member.kind === "model" ? (member.id.split("/").pop() ?? member.id) : member.id;
  return [member.name, member.name.split(/\s+/u)[0] ?? member.name, short, member.id].map(
    (handle) => handle.toLowerCase(),
  );
}

/** Members @mentioned in a message, in order, once each (the same rules as the aiwb-groups plugin). */
export function parseChatGroupMentions(
  text: string,
  members: readonly ChatGroupMember[],
): ChatGroupMember[] {
  const found: ChatGroupMember[] = [];
  for (const match of text.matchAll(/(?:^|[\s(])@([\p{L}\p{N}_.:/-]+(?: [\p{L}\p{N}_.-]+)?)/gu)) {
    const said = (match[1] ?? "").toLowerCase().replace(/[.,:;!?]+$/u, "");
    const first = (said.split(" ")[0] ?? "").replace(/[.,:;!?]+$/u, "");
    const member =
      members.find((candidate) => handles(candidate).includes(said)) ??
      members.find((candidate) => handles(candidate).includes(first));
    if (member && !found.includes(member)) {
      found.push(member);
    }
  }
  return found;
}

/** The composer draft with "@<name> " in front, replacing a leading mention of a member. */
export function draftAskingMember(
  draft: string,
  member: ChatGroupMember,
  members: readonly ChatGroupMember[],
): string {
  let rest = draft.trimStart();
  const lower = rest.toLowerCase();
  const leading = members
    .flatMap(handles)
    .toSorted((left, right) => right.length - left.length)
    .find(
      (handle) =>
        lower.startsWith(`@${handle}`) && /^(?:\s|$)/u.test(rest.slice(handle.length + 1)),
    );
  if (leading !== undefined) {
    rest = rest.slice(leading.length + 1).trimStart();
  }
  return `@${member.name} ${rest}`;
}
