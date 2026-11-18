import type { JSX } from "@solidjs/web";
import { createMemo, For, onSettled, Show, untrack } from "solid-js";
import type {
  SessionCatalog,
  SessionCatalogHost,
  SessionCatalogSession,
} from "../../../packages/gateway-protocol/src/index.ts";
import { normalizeSessionColorValue } from "../../../packages/gateway-protocol/src/session-agent-status.js";
import type { GatewaySessionRow } from "../api/types.ts";
import { formatUiError } from "../lib/format-error.ts";
import { handleContextMenuEvent } from "../lib/keyboard-shortcuts.ts";
import { handleNavigationClick } from "../lib/navigation-click.ts";
import { t } from "../lib/reactive/i18n.ts";
import { buildCatalogSessionKey, type CatalogSessionKey } from "../lib/sessions/catalog-key.ts";
import { openCatalogSessionInTerminal } from "../lib/sessions/catalog-terminal.ts";
import { sessionNavigationTarget } from "../lib/sessions/route-navigation.ts";
import { renderHoverMarquee } from "../lib/solid/hover-marquee.tsx";
import { renderCatalogFolderHead as CatalogFolderHead } from "./app-sidebar-catalog-folder-head.tsx";
import {
  createCatalogHostFolders,
  createCatalogHostReorder,
  visibleCatalogHostSessions,
} from "./app-sidebar-session-catalog-reorder.ts";
import {
  catalogErrorMessages,
  formatSidebarTimestamp,
  normalizeCatalogTimestamp,
  type CatalogSessionMenuRequest,
  type CatalogBackingSessionDisplay,
  type CatalogRowControls,
  catalogSessionActivity,
  catalogSessionRowsByKey,
  type SidebarSessionCatalog,
} from "./app-sidebar-session-catalogs.ts";
import type { SessionCatalogGroupsParams } from "./app-sidebar-session-render-types.ts";
import { renderRecentSession as RecentSession } from "./app-sidebar-session-row-render.tsx";
import { renderSidebarSessionSectionHeader as SessionSectionHeader } from "./app-sidebar-session-section-header.tsx";
import { hasProviderBrandIcon } from "./provider-icon-data.ts";
import { Icon } from "./solid/icon.tsx";
import { renderNewSessionLink as NewSessionLink } from "./solid/new-session-link.tsx";
import { ProviderBrandIcon } from "./solid/provider-icon.tsx";
import {
  SessionGlyph,
  SessionRowBadges,
  sessionRunVisibility,
} from "./solid/session-presentation.tsx";
const CATALOG_CONTROLS = [
  ["link", ".sidebar-recent-session__link"],
  ["children", "[data-child-session-toggle]"],
  ["pin", "[data-sidebar-session-pin]"],
  ["archive", "[data-sidebar-session-archive]"],
  ["menu", "[data-sidebar-session-menu]"],
  ["catalogMenu", "[data-catalog-session-menu]"],
] as const;
const CATALOG_SESSION_GROUP_LIMIT = 5;
export function renderSessionCatalogGroups(params: SessionCatalogGroupsParams) {
  // Adopted rows use canonical local labels and title snapshots; native catalog
  // refreshes must not rename them or replace the regular session presentation.
  const liveRowsByKey = createMemo(() => catalogSessionRowsByKey(params.snapshot.liveRows));
  return renderCatalogGroup(() => params.catalog, liveRowsByKey, params);
}
export type SessionCatalogGroupsRenderer = typeof renderSessionCatalogGroups;
function renderCatalogHostGroup(
  readCatalog: () => SessionCatalog,
  readHost: () => SessionCatalogHost,
  readLiveRowsByKey: () => ReadonlyMap<string, GatewaySessionRow>,
  params: SessionCatalogGroupsParams,
) {
  const identity = createMemo(() => ({ catalogId: readCatalog().id, hostId: readHost().hostId }));
  const { allProjectGroups, projectGroups } = createCatalogHostFolders(readHost, identity, params);
  const reorderState = createCatalogHostReorder(readCatalog, identity, allProjectGroups, params);
  const errorHelp = createMemo(() => {
    const readHostValue = readHost();
    return readHostValue.error
      ? formatUiError(`[${readHostValue.error.code}] ${readHostValue.error.message}`)
      : undefined;
  });
  function renderCatalogSessionRow(
    readSession: () => SessionCatalogSession,
    projectChild = false,
    /** Custom folder that owns this row; rows reorder only within it. */
    reorderGroup?: string,
  ) {
    const drag = reorderState.rowDrag(reorderGroup, () => catalogKey());
    const timestamp = createMemo(() =>
      normalizeCatalogTimestamp(
        readSession().recencyAt ?? readSession().updatedAt ?? readSession().createdAt,
      ),
    );
    const catalogKey = createMemo(() => {
      const readCatalogValue = readCatalog();
      const readHostValue = readHost();
      const readSessionValue = readSession();
      return {
        catalogId: readCatalogValue.id,
        hostId: readHostValue.hostId,
        threadId: readSessionValue.threadId,
        ...(readSessionValue.sourceHomeId
          ? {
              sourceHomeId: readSessionValue.sourceHomeId,
            }
          : {}),
      } satisfies CatalogSessionKey;
    });
    const identityKey = createMemo(() => buildCatalogSessionKey(catalogKey()));
    const key = createMemo(
      () =>
        readSession().sessionKey ??
        buildCatalogSessionKey(catalogKey(), params.snapshot.newSessionAgentId),
    );
    const label = createMemo(() => readSession().name || readSession().threadId);
    const meta = createMemo(() => formatSidebarTimestamp(timestamp()));
    const routeId = "chat";
    const target = createMemo(() =>
      sessionNavigationTarget({
        face: routeId,
        sessionKey: key(),
        fallbackAgentId: params.snapshot.newSessionAgentId,
        basePath: params.snapshot.basePath,
        mainKey: params.snapshot.mainKey,
      }),
    );
    const catalogMenu = createMemo<CatalogSessionMenuRequest>(() => ({
      key: catalogKey(),
      agentId: params.snapshot.newSessionAgentId,
      routeId,
      navigation: target().options,
      canOpenTerminal: readSession().canOpenTerminal === true,
      canDelete: readSession().canArchive && readCatalog().capabilities.archive,
      name: readSession().name ?? readSession().threadId,
      displayName: readSession().name,
      meta: meta(),
    }));
    const menuOpen = createMemo(() =>
      params.host.sidebarMenus.catalogMenuView.isOpenFor(catalogKey()),
    );
    const adoptedRow = createMemo(() => {
      const readSessionValue = readSession();
      const readLiveRowsByKeyValue = readLiveRowsByKey();
      return readSessionValue.sessionKey
        ? readLiveRowsByKeyValue.get(readSessionValue.sessionKey)
        : undefined;
    });
    const rowRef: NonNullable<CatalogBackingSessionDisplay["rowRef"]> = (
      element,
      controls,
      previousFocus,
    ) => {
      const stop = params.host.sessionProjection.mountCatalogRow(key());
      const active = previousFocus instanceof HTMLElement ? previousFocus : null;
      const activeRow = active?.closest<HTMLElement>("[data-session-key]");
      const control = CATALOG_CONTROLS.find(([, selector]) => active?.matches(selector))?.[0];
      const restoreFocus =
        control !== undefined &&
        (activeRow?.dataset.catalogSessionKey === identityKey() ||
          activeRow?.dataset.sessionKey === identityKey() ||
          activeRow?.dataset.sessionKey === key());
      if (menuOpen()) {
        params.host.sidebarMenus.catalogMenu.retargetTrigger(
          catalogKey(),
          controls.catalogMenu ?? controls.link,
        );
      }
      if (restoreFocus && control) {
        queueMicrotask(() => {
          if (element.isConnected && document.activeElement === document.body) {
            const focusTarget = controls[control];
            (focusTarget && element.contains(focusTarget) ? focusTarget : controls.link)?.focus({
              preventScroll: true,
            });
          }
        });
      }
      return stop;
    };
    const color = createMemo(() => normalizeSessionColorValue(readSession().color ?? ""));
    const active = createMemo(() => key() === params.snapshot.routeSessionKey);
    const running = () => readSession().status === "active" || readSession().status === "running";
    const canOpenTerminal = () =>
      readSession().canOpenTerminal === true && params.snapshot.terminalAvailable;
    const openMenu = (x: number, y: number, trigger?: HTMLElement) =>
      params.host.sidebarMenus.catalogMenu.open(catalogMenu(), x, y, trigger);
    const CatalogRow = () => {
      const controls: CatalogRowControls = {};
      const openMenuFromEvent: JSX.EventHandler<HTMLDivElement, MouseEvent | KeyboardEvent> = (
        event,
      ) =>
        handleContextMenuEvent(
          event,
          event instanceof KeyboardEvent ? (controls.catalogMenu ?? null) : null,
          (trigger, x, y) => openMenu(x, y, trigger ?? undefined),
        );
      const marqueeLabel = (
        <Show
          when={JSON.stringify([label(), readSession().status, readSession().pullRequest])}
          keyed
        >
          {(_identity) => <>{renderHoverMarquee(label(), "sidebar-recent-session__name")}</>}
        </Show>
      );
      let element: HTMLDivElement;
      let previousFocus: Element | null;
      onSettled(() => rowRef(element, controls, previousFocus));
      return (
        <div
          ref={(node) => {
            element = node;
            previousFocus = document.activeElement;
          }}
          class={[
            "sidebar-recent-session session-row-host sidebar-recent-session--single-line",
            {
              "sidebar-recent-session--colored": Boolean(color()),
              "sidebar-recent-session--active": active(),
              "sidebar-recent-session--catalog-project-child": projectChild,
              "session-row-host--running": running(),
            },
          ]}
          style={color() ? `--session-color: var(--session-color-${color()})` : undefined}
          data-session-key={key()}
          data-catalog-session-key={identityKey()}
          data-session-row-action-count="1"
          role="listitem"
          draggable={drag.draggable()}
          onDragStart={drag.onDragStart}
          onDragEnd={drag.onDragEnd}
          onContextMenu={openMenuFromEvent}
          onKeyDown={openMenuFromEvent}
        >
          <a
            ref={(node) => (controls.link = node)}
            href={target().href}
            class="sidebar-recent-session__link"
            draggable={drag.linkDraggable()}
            aria-current={active() ? "page" : undefined}
            onClick={(event: MouseEvent) =>
              handleNavigationClick(event, () => {
                if (params.snapshot.catalogOpenTarget === "terminal" && canOpenTerminal()) {
                  openCatalogSessionInTerminal(
                    params.host,
                    catalogKey(),
                    params.snapshot.newSessionAgentId,
                  );
                } else {
                  params.host.onNavigate?.(routeId, target().options);
                }
              })
            }
          >
            <span class="sidebar-session-indicator">
              {running() ? (
                <SessionGlyph
                  content={undefined}
                  running={running()}
                  runVisibility={sessionRunVisibility}
                />
              ) : undefined}
            </span>
            <span class="sidebar-recent-session__text">
              <span class="sidebar-recent-session__title-row"> {marqueeLabel} </span>
              <span class="sidebar-recent-session__details">
                <span class="sidebar-recent-session__details-endcap">
                  {<SessionRowBadges pullRequest={readSession().pullRequest} />}
                </span>
              </span>
            </span>
          </a>
          <span class="sidebar-recent-session__aside session-row-aside">
            <span class="session-row-actions">
              <button
                ref={(node) => (controls.catalogMenu = node)}
                class="session-action"
                data-catalog-session-menu="true"
                type="button"
                title={t("chat.sidebar.openSessionMenu")}
                aria-label={`${t("chat.sidebar.openSessionMenu")}: ${label()}`}
                aria-haspopup="menu"
                aria-expanded={menuOpen() ? "true" : "false"}
                onClick={(event) => {
                  event.stopPropagation();
                  const trigger = event.currentTarget;
                  const rect = trigger.getBoundingClientRect();
                  openMenu(rect.right, rect.bottom + 4, trigger);
                }}
              >
                <Icon name="moreHorizontal" />
              </button>
            </span>
          </span>
        </div>
      );
    };
    return (
      <Show when={adoptedRow()} fallback={<CatalogRow />}>
        {(liveRow) => (
          <RecentSession
            host={params.host}
            session={params.snapshot.toSidebarSession(liveRow())}
            display={{
              catalogIdentityKey: identityKey(),
              // A row that is a Gateway session of its own (not a native thread adopted into one)
              // is managed like any session: archive, delete, rename from the session menu.
              catalogMenu: readSession().source === "openclaw" ? undefined : catalogMenu(),
              rowRef,
              pullRequest: readSession().pullRequest,
              catalogReorder: drag.catalogReorder(),
            }}
          />
        )}
      </Show>
    );
  }

  function CatalogRows(rowProps: {
    sessions: readonly SessionCatalogSession[];
    sectionId: string;
    projectChild?: boolean;
    reorderGroup?: string;
  }) {
    const reorderGroup = untrack(() => rowProps.reorderGroup);
    // Fork: "Show more" stays open across refreshes and reloads.
    const expanded = () => params.host.catalogExpansion.sections.has(rowProps.sectionId);
    return (
      <For
        each={
          expanded() ? rowProps.sessions : rowProps.sessions.slice(0, CATALOG_SESSION_GROUP_LIMIT)
        }
        keyed={(session) =>
          buildCatalogSessionKey({
            catalogId: identity().catalogId,
            hostId: identity().hostId,
            threadId: session.threadId,
            ...(session.sourceHomeId ? { sourceHomeId: session.sourceHomeId } : {}),
          })
        }
      >
        {(session) =>
          renderCatalogSessionRow(session, rowProps.projectChild === true, reorderGroup)
        }
      </For>
    );
  }
  function CatalogPagination(pageProps: {
    sessions: readonly SessionCatalogSession[];
    sectionId: string;
  }) {
    const expanded = () => params.host.catalogExpansion.sections.has(pageProps.sectionId);
    const label = () => (expanded() ? t("chat.messages.showLess") : t("chat.messages.showMore"));
    return (
      <Show when={pageProps.sessions.length > CATALOG_SESSION_GROUP_LIMIT}>
        <div class="sidebar-session-pagination sidebar-session-pagination--catalog">
          <button
            type="button"
            class="sidebar-session-pagination__button"
            aria-label={label()}
            aria-expanded={expanded() ? "true" : "false"}
            onClick={() => params.host.catalogExpansion.set(pageProps.sectionId, !expanded())}
          >
            {label()}
          </button>
        </div>
      </Show>
    );
  }
  const flatSessions = createMemo(() => projectGroups()?.ungrouped ?? readHost().sessions);
  const flatSectionId = createMemo(() => {
    const projectGroupsValue = projectGroups();
    const readCatalogValue = readCatalog();
    const readHostValue = readHost();
    return projectGroupsValue
      ? `catalog-${params.snapshot.projectGrouping}-ungrouped:${readCatalogValue.id}:${readHostValue.hostId}`
      : `catalog-host:${readCatalogValue.id}:${readHostValue.hostId}`;
  });
  // Gateway errors stay on the catalog header; node headings remain so remote rows keep their owner.
  const showHostHeading = createMemo(() => readHost().kind !== "gateway");
  return (
    <section class="sidebar-session-catalog-host" data-session-catalog-host={readHost().hostId}>
      {showHostHeading() ? (
        <div
          class="sidebar-session-catalog-host__head"
          aria-label={errorHelp() ? `${readHost().label}: ${errorHelp()}` : readHost().label}
          title={errorHelp() ?? readHost().label}
        >
          <span class="sidebar-session-group-toggle__lead" aria-hidden="true">
            <span class="sidebar-session-group-toggle__icon">
              <Icon name="monitor" />
            </span>
          </span>
          <span class="sidebar-session-catalog-host__label">{readHost().label}</span>
          <span
            class={[
              "sidebar-session-catalog-host__count",
              { "sidebar-session-catalog-host__count--error": Boolean(readHost().error) },
            ]}
            aria-hidden="true"
          >
            {readHost().error ? <Icon name="alertTriangle" /> : readHost().sessions.length}
          </span>
        </div>
      ) : undefined}
      <div class="sidebar-session-catalog-host__sessions" role="list" aria-label={readHost().label}>
        {projectGroups() ? (
          <For each={projectGroups()!.groups} keyed={(group) => group.key}>
            {(group) => {
              const sectionId = createMemo(
                () =>
                  `catalog-${group().kind}:${identity().catalogId}:${identity().hostId}:${group().key}`,
              );
              const legacySectionId = createMemo(() =>
                group().legacySectionKey
                  ? `catalog-project:${readCatalog().id}:${readHost().hostId}:${group().legacySectionKey}`
                  : null,
              );
              const collapsedSectionId = createMemo(() => {
                const legacyId = legacySectionId();
                return params.host.collapsedSessionSections.has(sectionId())
                  ? sectionId()
                  : legacyId && params.host.collapsedSessionSections.has(legacyId)
                    ? legacyId
                    : null;
              });
              const collapsed = createMemo(() => collapsedSectionId() !== null);
              const customFolder = untrack(() =>
                group().kind === "custom" ? group().label : undefined,
              );
              const drag = reorderState.folderDrag({ customFolder, rows: () => group().sessions });
              return (
                <div
                  class={drag.folderClass()}
                  role="listitem"
                  draggable={drag.draggable()}
                  onMouseDown={drag.onMouseDown}
                  onDragStart={drag.onDragStart}
                  onDragEnd={drag.onDragEnd}
                  onDragOver={drag.onDragOver}
                  onDragLeave={drag.onDragLeave}
                  onDrop={drag.onDrop}
                >
                  <CatalogFolderHead
                    catalogId={identity().catalogId}
                    group={group}
                    collapsed={collapsed}
                    onToggle={() => params.host.toggleSection(collapsedSectionId() ?? sectionId())}
                    params={params}
                  />
                  {collapsed() ? undefined : (
                    <>
                      <div
                        class="sidebar-session-catalog-project__sessions"
                        role="list"
                        aria-label={`${readHost().label}: ${group().label}`}
                        onDragOver={drag.onRowsDragOver}
                        onDragLeave={drag.onRowsDragLeave}
                        onDrop={drag.onRowsDrop}
                      >
                        <CatalogRows
                          sessions={group().sessions}
                          sectionId={sectionId()}
                          projectChild
                          reorderGroup={customFolder}
                        />
                      </div>
                      <CatalogPagination sessions={group().sessions} sectionId={sectionId()} />
                    </>
                  )}
                </div>
              );
            }}
          </For>
        ) : undefined}
        <CatalogRows sessions={flatSessions()} sectionId={flatSectionId()} />
      </div>
      <CatalogPagination sessions={flatSessions()} sectionId={flatSectionId()} />
    </section>
  );
}
function renderCatalogGroup(
  readCatalog: () => SidebarSessionCatalog,
  readLiveRowsByKey: () => ReadonlyMap<string, GatewaySessionRow>,
  params: SessionCatalogGroupsParams,
) {
  const newSessionAccess = createMemo(() => params.host.readNewSessionAccess());
  const groupWriteAccess = createMemo(() =>
    params.host.readSessionMutationAccess({
      method: "sessions.groups.put",
      requiredScope: "operator.write",
    }),
  );
  const sectionDragDisabledReason = () => {
    const access = groupWriteAccess();
    return access.allowed ? undefined : access.reason;
  };
  const sectionId = createMemo(() => `catalog:${readCatalog().id}`);
  const collapsed = createMemo(() => params.host.collapsedSessionSections.has(sectionId()));
  const rows = createMemo(() =>
    readCatalog().visibleHosts.flatMap((host) =>
      visibleCatalogHostSessions(readCatalog().id, host, params),
    ),
  );
  const activity = createMemo(() =>
    catalogSessionActivity(
      rows(),
      readLiveRowsByKey(),
      (row) => params.host.sessionDataContext?.sessions.isRunVisuallyActive(row) ?? false,
    ),
  );
  let viewMenuTrigger: HTMLButtonElement | undefined;
  const hasActiveRun = createMemo(() => activity().running);
  const hasUnread = createMemo(() => activity().unread);
  const hasBrandIcon = createMemo(() => hasProviderBrandIcon(readCatalog().id));
  const loadingMore = createMemo(
    () =>
      params.snapshot.loadingMoreCatalogIds.has(readCatalog().id) ||
      Boolean(
        readCatalog().requiresFreshList &&
        (readCatalog().pending || readCatalog().hosts.some((host) => host.pending)),
      ),
  );
  const hasMore = createMemo(() => readCatalog().hosts.some((host) => Boolean(host.nextCursor)));
  const canCreateSession = createMemo(() => readCatalog().capabilities.startTerminal === true);
  const errorMessages = createMemo(() => catalogErrorMessages(readCatalog()));
  const hasError = createMemo(() => errorMessages().length > 0);
  const retryFresh = () => readCatalog().requiresFreshList && hasError();
  const errorMessage = createMemo(() => errorMessages().join("; "));
  const errorHelp = createMemo(() =>
    t("chat.sidebar.catalogDiscoveryHelp", {
      error: errorMessage(),
    }),
  );
  return (
    <div
      class={[
        "sidebar-recent-sessions__group sidebar-recent-sessions__group--zone-coding",
        params.host.sessionOrganizer.sidebarSectionDropTarget?.sectionId === sectionId() &&
          `sidebar-recent-sessions__group--section-drop-${params.host.sessionOrganizer.sidebarSectionDropTarget.position}`,
        {
          "sidebar-recent-sessions__group--collapsed": collapsed(),
          "sidebar-recent-sessions__group--dragging":
            params.host.sessionOrganizer.draggingSidebarSection === sectionId(),
        },
      ]}
      data-session-section={sectionId()}
      onDragOver={(event: DragEvent) => {
        if (!sectionDragDisabledReason()) {
          params.host.sessionOrganizer.sectionDragOver(event, sectionId());
        }
      }}
      onDragLeave={(event: DragEvent) => {
        if (!sectionDragDisabledReason()) {
          params.host.sessionOrganizer.sectionDragLeave(event, sectionId());
        }
      }}
      onDrop={(event: DragEvent) => {
        if (!sectionDragDisabledReason()) {
          params.host.sessionOrganizer.sectionDrop(event, sectionId());
        }
      }}
    >
      <SessionSectionHeader
        sectionId={sectionId()}
        sectionHeaders={params.host.sessionOrganizer.sectionHeaders}
        status={
          hasError() || (collapsed() && rows().length > 0)
            ? {
                label: hasError() ? `${readCatalog().label}: ${errorHelp()}` : readCatalog().label,
                expanded: !collapsed(),
                title: hasError() ? errorHelp() : undefined,
                onToggle: () => params.host.toggleSection(sectionId()),
                content: (
                  <span
                    class={[
                      "sidebar-session-group-count",
                      { "sidebar-session-group-count--error": hasError() },
                    ]}
                    data-session-catalog-error={hasError() ? readCatalog().id : undefined}
                    aria-hidden="true"
                  >
                    {hasError() ? <Icon name="alertTriangle" /> : rows().length}
                  </span>
                ),
              }
            : undefined
        }
        disabledReason={sectionDragDisabledReason()}
        onStartDrag={(id) => params.host.sessionOrganizer.startSidebarSectionDrag(id)}
        onFinishDrag={() => params.host.sessionOrganizer.finishSidebarSectionDrag()}
        onContextMenu={(event) => {
          event.preventDefault();
          params.host.sidebarMenus.openCatalogViewMenu(
            readCatalog().id,
            event.clientX,
            event.clientY,
            viewMenuTrigger ?? event.currentTarget,
          );
        }}
        content={
          <>
            <button
              type="button"
              class="sidebar-session-group-toggle"
              aria-expanded={collapsed() ? "false" : "true"}
              aria-label={
                hasError() ? `${readCatalog().label}: ${errorHelp()}` : readCatalog().label
              }
              title={hasError() ? errorHelp() : undefined}
              onClick={() => params.host.toggleSection(sectionId())}
            >
              <span
                class={[
                  "sidebar-session-group-toggle__lead",
                  { "sidebar-session-group-toggle__lead--branded": hasBrandIcon() },
                ]}
                aria-hidden="true"
              >
                {hasBrandIcon() ? (
                  <ProviderBrandIcon
                    provider={readCatalog().id}
                    class="sidebar-session-catalog-provider-icon"
                  />
                ) : undefined}
                <span class="sidebar-session-group-toggle__icon">
                  {collapsed() ? <Icon name="chevronRight" /> : <Icon name="chevronDown" />}
                </span>
              </span>
              {renderHoverMarquee(readCatalog().label, "sidebar-recent-sessions__label-text")}
              {hasActiveRun() ? (
                <span
                  class="session-run-spinner"
                  role="img"
                  aria-label={t("sessionsView.activeRun")}
                  title={t("sessionsView.activeRun")}
                />
              ) : hasUnread() ? (
                <span class="session-unread-dot" role="img" aria-label={t("sessionsView.unread")} />
              ) : undefined}
            </button>
            <button
              ref={(element) => (viewMenuTrigger = element)}
              type="button"
              class={[
                "sidebar-session-group-actions sidebar-session-sort sidebar-session-catalog-grouping",
                { "sidebar-session-sort--filtered": params.host.sessionOwnerFilterActive },
              ]}
              data-session-catalog-view-menu={readCatalog().id}
              title={t("chat.sidebar.catalogViewOptions")}
              aria-label={t("chat.sidebar.catalogViewOptions")}
              aria-haspopup="menu"
              aria-expanded={
                params.host.sidebarMenus.catalogViewMenuPosition?.catalogId === readCatalog().id
                  ? "true"
                  : "false"
              }
              onClick={(event) => {
                event.stopPropagation();
                params.host.sidebarMenus.toggleCatalogViewMenu(
                  readCatalog().id,
                  event.currentTarget,
                );
              }}
            >
              <Icon name="listFilter" />
            </button>
            {canCreateSession() ? (
              <NewSessionLink
                basePath={params.snapshot.basePath}
                agentId={params.snapshot.newSessionAgentId}
                target={{ catalogId: readCatalog().id }}
                class="sidebar-session-group-actions sidebar-session-new sidebar-session-catalog-new"
                label={`${t("chat.runControls.newSession")} — ${readCatalog().label}`}
                disabledReason={(() => {
                  const access = newSessionAccess();
                  return access.allowed ? undefined : access.reason;
                })()}
                onOpen={(agentId, target) => params.host.requestOpenNewSession(agentId, target)}
              />
            ) : undefined}
          </>
        }
      />
      {collapsed() ? undefined : (
        <>
          <div class="sidebar-recent-sessions__list">
            <For each={readCatalog().visibleHosts} keyed={(host) => host.hostId}>
              {(host) => renderCatalogHostGroup(readCatalog, host, readLiveRowsByKey, params)}
            </For>
          </div>
          {hasMore() || retryFresh() ? (
            <button
              type="button"
              class="sidebar-session-catalog-load-more"
              data-session-catalog-load-more={readCatalog().id}
              disabled={loadingMore()}
              aria-busy={loadingMore() ? "true" : "false"}
              onClick={() => void params.host.sessionData.loadMoreSessionCatalog(readCatalog().id)}
            >
              {retryFresh() ? t("common.retry") : t("chat.selectors.loadMoreSessions")}
            </button>
          ) : undefined}
        </>
      )}
    </div>
  );
}
