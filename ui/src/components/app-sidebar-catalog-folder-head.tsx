import type { JSX } from "@solidjs/web";
import { createMemo } from "solid-js";
import type { SessionCatalogSession } from "../../../packages/gateway-protocol/src/index.ts";
import { t } from "../lib/reactive/i18n.ts";
import type { SessionCatalogGroupsParams } from "./app-sidebar-session-render-types.ts";
import {
  catalogFolderMenuContext,
  isContextMenuKeyEvent,
  resolveCatalogFolderTargets,
  type CatalogFolderMenuContext,
} from "./sidebar-catalog-folder-actions.ts";
import { Icon } from "./solid/icon.tsx";
import { renderNewSessionLink } from "./solid/new-session-link.tsx";
import "../styles/sidebar-catalog-folder.css";

type FolderGroup = {
  kind: CatalogFolderMenuContext["kind"];
  key: string;
  label: string;
  title: string;
  sessions: readonly SessionCatalogSession[];
};

/**
 * Fork: a catalog folder's header row. The header toggles the folder; right-click, the Menu key,
 * Shift+F10 or the ⋯ button open the folder menu; + opens a new chat in the folder when an agent
 * for it is known. The buttons show on hover and keyboard focus, like other sidebar row actions.
 */
export function renderCatalogFolderHead(props: {
  catalogId: string;
  group: () => FolderGroup;
  collapsed: () => boolean;
  onToggle: () => void;
  params: SessionCatalogGroupsParams;
}): JSX.Element {
  const context = () =>
    catalogFolderMenuContext({
      kind: props.group().kind,
      title: props.group().title,
      sessions: props.group().sessions,
      fallbackAgentId: props.params.snapshot.newSessionAgentId,
      collapsed: props.collapsed(),
      onToggle: props.onToggle,
    });
  const newChat = createMemo(
    () =>
      resolveCatalogFolderTargets(
        props.params.host.sessionDataContext,
        context(),
        props.group().label,
      ).newChat,
  );
  const newSessionAccess = createMemo(() => props.params.host.readNewSessionAccess());
  let head: HTMLButtonElement | undefined;
  const openMenu = (trigger: HTMLElement, x: number, y: number) =>
    props.params.host.sidebarMenus.openCatalogFolderMenu(
      props.catalogId,
      props.group().key,
      props.group().label,
      context(),
      x,
      y,
      trigger,
    );
  const openMenuBelow = (trigger: HTMLElement) => {
    const rect = trigger.getBoundingClientRect();
    openMenu(trigger, rect.left, rect.bottom + 4);
  };
  return (
    <div class="sidebar-session-catalog-project__row">
      <button
        ref={(element: HTMLButtonElement) => {
          head = element;
        }}
        type="button"
        class="sidebar-session-catalog-project__head"
        data-session-catalog-project={props.group().key}
        aria-expanded={props.collapsed() ? "false" : "true"}
        title={props.group().title}
        onClick={() => props.onToggle()}
        onKeyDown={(event: KeyboardEvent) => {
          if (isContextMenuKeyEvent(event)) {
            event.preventDefault();
            event.stopPropagation();
            openMenuBelow(event.currentTarget as HTMLElement);
          }
        }}
        onContextMenu={(event: MouseEvent) => {
          event.preventDefault();
          event.stopPropagation();
          openMenu(event.currentTarget as HTMLElement, event.clientX, event.clientY);
        }}
      >
        <span class="sidebar-session-catalog-project__icon" aria-hidden="true">
          {props.collapsed() ? <Icon name="chevronRight" /> : <Icon name="chevronDown" />}
        </span>
        <span class="sidebar-session-catalog-project__label">{props.group().label}</span>
        <span class="sidebar-session-catalog-project__count" aria-hidden="true">
          {props.group().sessions.length}
        </span>
      </button>
      <span class="sidebar-session-catalog-project__actions">
        {newChat()
          ? renderNewSessionLink({
              get basePath() {
                return props.params.snapshot.basePath;
              },
              get agentId() {
                return newChat()?.agentId ?? "";
              },
              get target() {
                return newChat()?.target;
              },
              class: "sidebar-session-catalog-project__action",
              get label() {
                return `${t("chat.sidebar.folderNewChat")} — ${props.group().label}`;
              },
              get disabledReason() {
                const access = newSessionAccess();
                return access.allowed ? undefined : access.reason;
              },
              onOpen: (
                agentId: string,
                target?: Parameters<typeof props.params.host.requestOpenNewSession>[1],
              ) => props.params.host.requestOpenNewSession(agentId, target),
            })
          : undefined}
        <button
          type="button"
          class="sidebar-session-catalog-project__action"
          data-session-catalog-folder-menu={props.group().key}
          title={t("chat.sidebar.folderActions", { folder: props.group().label })}
          aria-label={t("chat.sidebar.folderActions", { folder: props.group().label })}
          aria-haspopup="menu"
          onClick={(event: MouseEvent) => {
            event.stopPropagation();
            const trigger = event.currentTarget as HTMLElement;
            const rect = (head ?? trigger).getBoundingClientRect();
            openMenu(trigger, rect.left, rect.bottom + 4);
          }}
        >
          <Icon name="moreHorizontal" />
        </button>
      </span>
    </div>
  );
}
