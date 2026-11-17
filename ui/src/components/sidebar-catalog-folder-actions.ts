import type { SessionCatalogSession } from "../../../packages/gateway-protocol/src/index.ts";
import type { ApplicationContext } from "../app/context.ts";
import { normalizeAgentId, parseAgentSessionKey } from "../lib/sessions/session-key.ts";
import type { NewSessionTarget } from "../pages/new-session/location.ts";

/**
 * Fork: what the project folder menu of a session catalog knows about one folder. The sidebar
 * builds it from the folder's rows when the menu opens; the menu never re-reads the tree.
 */
export type CatalogFolderMenuContext = {
  kind: "custom" | "project" | "person";
  /** The folder path of a project folder; null for custom and person folders. */
  path: string | null;
  /** Agents of the folder's chats that OpenClaw already opened, most frequent first. */
  sessionAgentIds: readonly string[];
  /** One opened chat per agent, used to ask the Gateway for that agent's folder. */
  sessionKeysByAgent: Readonly<Record<string, string>>;
  /** The sidebar's own new-session agent, used for a custom folder that maps to a session group. */
  fallbackAgentId: string;
  collapsed: boolean;
  onToggle: () => void;
};

export type CatalogFolderMenuAction =
  | "new-chat"
  | "reveal"
  | "copy-path"
  | "agent-settings"
  | "toggle"
  | "hide-catalog-folder";

export type CatalogFolderNewChat = { agentId: string; target?: NewSessionTarget };

type AgentLike = { id: string; workspace?: string; cwd?: string };

export type FolderAppContext =
  | Pick<ApplicationContext, "agents" | "gateway" | "sessions">
  | undefined;

function trimFolderPath(path: string): string {
  return path.replaceAll("\\", "/").replace(/\/+$/, "");
}

export function catalogFolderMenuContext(params: {
  kind: CatalogFolderMenuContext["kind"];
  title: string;
  sessions: readonly Pick<SessionCatalogSession, "sessionKey">[];
  fallbackAgentId: string;
  collapsed: boolean;
  onToggle: () => void;
}): CatalogFolderMenuContext {
  const counts = new Map<string, number>();
  const sessionKeysByAgent: Record<string, string> = {};
  for (const session of params.sessions) {
    const agentId = parseAgentSessionKey(session.sessionKey)?.agentId;
    if (!agentId || !session.sessionKey) {
      continue;
    }
    counts.set(agentId, (counts.get(agentId) ?? 0) + 1);
    sessionKeysByAgent[agentId] ??= session.sessionKey;
  }
  // A stable sort keeps the first-seen agent ahead on ties.
  const sessionAgentIds = [...counts.keys()].toSorted(
    (left, right) => (counts.get(right) ?? 0) - (counts.get(left) ?? 0),
  );
  return {
    kind: params.kind,
    path: params.kind === "project" && params.title.trim() ? params.title.trim() : null,
    sessionAgentIds,
    sessionKeysByAgent,
    fallbackAgentId: params.fallbackAgentId,
    collapsed: params.collapsed,
    onToggle: params.onToggle,
  };
}

/**
 * The agent that works in this folder: the agent of most of its opened chats, else (for a project
 * folder) the one agent whose run folder (`cwd`) is that folder, else the one agent whose workspace
 * is that folder. Unknown agents are skipped once the agent list is loaded, so a deleted agent
 * never preselects; several agents sharing the folder leave the choice open.
 */
export function resolveCatalogFolderAgent(
  context: Pick<CatalogFolderMenuContext, "path" | "sessionAgentIds">,
  agents: readonly AgentLike[] | null | undefined,
): string | null {
  const known = agents ? new Set(agents.map((agent) => normalizeAgentId(agent.id))) : null;
  const fromSessions = context.sessionAgentIds.find(
    (agentId) => !known || known.has(normalizeAgentId(agentId)),
  );
  if (fromSessions) {
    return normalizeAgentId(fromSessions);
  }
  if (!context.path || !agents) {
    return null;
  }
  const folder = trimFolderPath(context.path);
  for (const field of ["cwd", "workspace"] as const) {
    const matches = agents.filter((agent) => {
      const value = agent[field];
      return value !== undefined && trimFolderPath(value) === folder;
    });
    if (matches.length === 1) {
      return normalizeAgentId(matches[0]!.id);
    }
    if (matches.length > 1) {
      return null;
    }
  }
  return null;
}

/**
 * Where "New chat in this folder" goes. A custom folder named like a session group opens the draft
 * in that group (its folder and defaults); a project folder opens a draft with its agent, whose
 * working folder is the project. Person folders and folders without an agent offer no new chat.
 */
export function resolveCatalogFolderNewChat(
  context: Pick<CatalogFolderMenuContext, "kind" | "fallbackAgentId">,
  label: string,
  agentId: string | null,
  sessionGroupNames: readonly string[],
): CatalogFolderNewChat | null {
  if (context.kind === "person") {
    return null;
  }
  if (context.kind === "custom" && sessionGroupNames.includes(label)) {
    const groupAgent = agentId ?? context.fallbackAgentId;
    return groupAgent ? { agentId: groupAgent, target: { group: label } } : null;
  }
  return agentId ? { agentId } : null;
}

export type CatalogFolderMenuEntry = {
  action: CatalogFolderMenuAction;
  disabledReason?: string;
};

/** The menu, in the order neighbours use: create, locate, configure, then view and hide. */
export function catalogFolderMenuEntries(params: {
  context: Pick<CatalogFolderMenuContext, "kind" | "path">;
  newChat: CatalogFolderNewChat | null;
  newChatDisabledReason?: string;
  noAgentReason: string;
  agentId: string | null;
  reveal: { available: boolean; disabledReason?: string };
}): CatalogFolderMenuEntry[] {
  const entries: CatalogFolderMenuEntry[] = [];
  if (params.context.kind !== "person") {
    entries.push({
      action: "new-chat",
      disabledReason: params.newChat
        ? params.newChatDisabledReason
        : (params.newChatDisabledReason ?? params.noAgentReason),
    });
  }
  if (params.context.path) {
    if (params.reveal.available) {
      entries.push({ action: "reveal", disabledReason: params.reveal.disabledReason });
    }
    entries.push({ action: "copy-path" });
  }
  if (params.agentId) {
    entries.push({ action: "agent-settings" });
  }
  entries.push({ action: "toggle" }, { action: "hide-catalog-folder" });
  return entries;
}

/** The keyboard's own context-menu gestures: the Menu key and Shift+F10. */
export function isContextMenuKeyEvent(
  event: Pick<KeyboardEvent, "key" | "shiftKey" | "altKey" | "ctrlKey" | "metaKey">,
): boolean {
  if (event.altKey || event.ctrlKey || event.metaKey) {
    return false;
  }
  return event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey);
}

export type CatalogFolderRevealTarget = { root?: string; path: string };

/**
 * Where `sessions.files.reveal` opens this folder for a chat of the folder, from that chat's
 * `sessions.files.list` folders (the workspace first, then the browse roots outside it): the
 * folder relative to the first of them that holds it, naming the browse root when it is not the
 * workspace. Null when no folder of the chat holds it.
 */
export function catalogFolderRevealTarget(
  roots: readonly string[],
  folder: string,
): CatalogFolderRevealTarget | null {
  const target = trimFolderPath(folder);
  for (const [index, rawRoot] of roots.entries()) {
    const root = trimFolderPath(rawRoot);
    const path =
      target === root ? "" : target.startsWith(`${root}/`) ? target.slice(root.length + 1) : null;
    if (path !== null) {
      return index === 0 ? { path } : { root: rawRoot, path };
    }
  }
  return null;
}

/** Agent and new-chat destination for a folder, from the live agent list and session groups. */
export function resolveCatalogFolderTargets(
  app: FolderAppContext,
  context: CatalogFolderMenuContext,
  label: string,
): { agentId: string | null; newChat: CatalogFolderNewChat | null } {
  const agents = app?.agents.state.agentsList?.agents;
  const agentId = resolveCatalogFolderAgent(context, agents);
  const groupNames = (app?.sessions.state.groupSettings ?? []).map((group) => group.name);
  return { agentId, newChat: resolveCatalogFolderNewChat(context, label, agentId, groupNames) };
}
