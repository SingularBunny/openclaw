import type { JSX } from "@solidjs/web";
import { createSignal } from "solid-js";
import { normalizeAgentLabel } from "../lib/agents/display.ts";
import { t } from "../lib/reactive/i18n.ts";
import { SidebarDropdown, renderSidebarMenuAction } from "./app-sidebar-nav-menus.tsx";
import type { IconName } from "./icon-data.ts";
import {
  catalogFolderMenuEntries,
  resolveCatalogFolderTargets,
  type CatalogFolderMenuAction,
  type CatalogFolderRevealTarget,
} from "./sidebar-catalog-folder-actions.ts";
import {
  catalogFolderRevealSource,
  checkCatalogFolderReveal,
  copyCatalogFolderPath,
  openCatalogFolderAgentSettings,
  openCatalogFolderNewChat,
  revealCatalogFolder,
} from "./sidebar-catalog-folder-run.ts";
import type { SidebarMenusOwner } from "./sidebar-menus-types.ts";
import type { SidebarMenus } from "./sidebar-menus.tsx";
import type { MenuEntry } from "./solid/menu.tsx";

const ICONS: Record<CatalogFolderMenuAction, IconName> = {
  "new-chat": "plus",
  reveal: "folder",
  "copy-path": "copy",
  "agent-settings": "settings",
  toggle: "chevronDown",
  "hide-catalog-folder": "eyeOff",
};

/**
 * Fork: the project folder menu of a session catalog (right-click, Menu key / Shift+F10, or the
 * folder's ⋯ button). Every item uses an existing mechanism: the new-session draft, the Gateway's
 * `sessions.files.reveal`, the clipboard, Settings → Agents, the tree's collapse and hide.
 */
export function renderSidebarCatalogFolderMenu(
  menus: SidebarMenus,
  host: SidebarMenusOwner,
  position: NonNullable<SidebarMenus["catalogFolderMenuPosition"]>,
): JSX.Element {
  const { context } = position;
  const app = host.sessionDataContext;
  const { agentId, newChat } = resolveCatalogFolderTargets(app, context, position.label);
  const agent = agentId
    ? app?.agents.state.agentsList?.agents.find((entry) => entry.id === agentId)
    : undefined;
  const newSessionAccess = host.readNewSessionAccess();
  const revealSource = catalogFolderRevealSource(app, context, agentId);
  // undefined: still asking the Gateway; null: outside every folder it can open for the chat.
  const [revealPath, setRevealPath] = createSignal<CatalogFolderRevealTarget | null | undefined>(
    undefined,
  );
  if (revealSource && context.path) {
    void checkCatalogFolderReveal(app, revealSource, context.path).then((path) =>
      setRevealPath(path),
    );
  }
  const labels: Record<CatalogFolderMenuAction, string> = {
    "new-chat": t("chat.sidebar.folderNewChat"),
    reveal: t("chat.sidebar.folderReveal"),
    "copy-path": t("chat.sidebar.folderCopyPath"),
    "agent-settings": t("chat.sidebar.folderAgentSettings", {
      agent: agent ? normalizeAgentLabel(agent) : (agentId ?? ""),
    }),
    toggle: context.collapsed ? t("chat.sidebar.folderExpand") : t("chat.sidebar.folderCollapse"),
    "hide-catalog-folder": t("chat.sidebar.hideFromSidebar"),
  };
  const entries = () =>
    catalogFolderMenuEntries({
      context,
      newChat,
      newChatDisabledReason: newSessionAccess.allowed ? undefined : newSessionAccess.reason,
      noAgentReason: t("chat.sidebar.folderNewChatNoAgent"),
      agentId,
      reveal: {
        available: Boolean(revealSource),
        disabledReason:
          revealPath() === undefined
            ? t("chat.sidebar.folderRevealChecking")
            : revealPath() === null
              ? t("chat.sidebar.folderRevealOutside")
              : undefined,
      },
    });
  const items = (): MenuEntry[] =>
    entries().flatMap((entry, index, all) => {
      const item = renderSidebarMenuAction(
        entry.action,
        labels[entry.action],
        ICONS[entry.action],
        {
          disabled: Boolean(entry.disabledReason),
          title: entry.disabledReason,
          className: "sidebar-session-sort-menu__item",
        },
      );
      const previous = all[index - 1]?.action;
      // Separators between the create, locate, configure and view blocks.
      const startsBlock =
        index > 0 &&
        (entry.action === "reveal" ||
          (entry.action === "copy-path" && previous !== "reveal") ||
          entry.action === "agent-settings" ||
          entry.action === "toggle");
      return startsBlock
        ? [
            {
              kind: "content" as const,
              id: `separator-${entry.action}`,
              content: <div class="session-menu__separator" role="separator" />,
            },
            item,
          ]
        : [item];
    });
  const run = (value: string) => {
    const entry = entries().find((candidate) => candidate.action === value);
    if (!entry || entry.disabledReason || menus.catalogFolderMenuPosition !== position) {
      return;
    }
    // New chat navigates away and Hide removes the folder, so neither returns focus to it.
    menus.closePositionedMenu("catalogFolder", {
      restoreFocus: entry.action !== "new-chat" && entry.action !== "hide-catalog-folder",
    });
    switch (entry.action) {
      case "new-chat":
        openCatalogFolderNewChat(newChat, (id, target) => host.requestOpenNewSession(id, target));
        break;
      case "reveal": {
        const target = revealPath();
        if (revealSource && target) {
          void revealCatalogFolder(app, revealSource, target);
        }
        break;
      }
      case "copy-path":
        copyCatalogFolderPath(context.path);
        break;
      case "agent-settings":
        openCatalogFolderAgentSettings(agentId, host.basePath, host.onNavigate);
        break;
      case "toggle":
        context.onToggle();
        break;
      case "hide-catalog-folder":
        host.hideSessionCatalogFolder(position.catalogId, position.folderId, position.label);
        break;
    }
  };
  return (
    <SidebarDropdown
      position={position}
      class="sidebar-session-sort-menu sidebar-catalog-folder-menu"
      label={t("chat.sidebar.catalogFolderMenu", { folder: position.label })}
      onSelect={run}
      {...menus.positionedMenuHandlers("catalogFolder")}
      items={items()}
    />
  );
}
