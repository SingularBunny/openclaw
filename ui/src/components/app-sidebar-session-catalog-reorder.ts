import { createMemo, createSignal } from "solid-js";
import type {
  SessionCatalog,
  SessionCatalogHost,
  SessionCatalogSession,
  SessionsCatalogMoveParams,
  SessionsCatalogReorderParams,
} from "../../../packages/gateway-protocol/src/index.ts";
import { formatUiError } from "../lib/format-error.ts";
import { buildCatalogSessionKey } from "../lib/sessions/catalog-key.ts";
import {
  groupCatalogSessionsByPerson,
  groupCatalogSessionsByProject,
  type CatalogProjectGrouping,
} from "../lib/sessions/catalog-project-grouping.ts";
import { moveCatalogOrderEntry } from "../lib/sessions/catalog-reorder.ts";
import {
  activeCatalogReorderDragData,
  finishCatalogReorderDrag,
  readCatalogReorderDragData,
  writeCatalogReorderDragData,
  type CatalogReorderDragPayload,
} from "../lib/sessions/drag-fork.ts";
import { showToast } from "../lib/toast.ts";
import {
  catalogFolderMoveDragOver,
  catalogFolderMoveDrop,
  catalogRowDragOver,
  catalogRowDrop,
  dropPosition,
  ROW_DROP_CLASSES,
  type CatalogFolderRowDrop,
  type DropPosition,
} from "./app-sidebar-session-catalog-drag.ts";
import type { SessionCatalogGroupsParams } from "./app-sidebar-session-render-types.ts";
import { sessionCatalogFolderKey } from "./app-sidebar-session-types-fork.ts";

export type CatalogFolder = ReturnType<typeof groupCatalogSessionsByProject>["groups"][number];
type CatalogFolderGroups = ReturnType<typeof groupCatalogSessionsByProject>;
type CatalogIdentity = { catalogId: string; hostId: string };

export function catalogFolderGroups(
  sessions: readonly SessionCatalogSession[],
  grouping: CatalogProjectGrouping,
) {
  return grouping === "project"
    ? groupCatalogSessionsByProject(sessions)
    : grouping === "person"
      ? groupCatalogSessionsByPerson(sessions)
      : null;
}

// A hidden folder stays while it holds the open session, so the current chat keeps its row.
export function visibleCatalogFolders(
  catalogId: string,
  hostId: string,
  folders: readonly CatalogFolder[],
  params: SessionCatalogGroupsParams,
): CatalogFolder[] {
  return folders.filter(
    (folder) =>
      !params.host.hiddenSessionCatalogFolderKeys.has(
        sessionCatalogFolderKey(catalogId, folder.key),
      ) ||
      folder.sessions.some(
        (session) =>
          (session.sessionKey ??
            buildCatalogSessionKey(
              {
                catalogId,
                hostId,
                threadId: session.threadId,
                ...(session.sourceHomeId ? { sourceHomeId: session.sourceHomeId } : {}),
              },
              params.snapshot.newSessionAgentId,
            )) === params.snapshot.routeSessionKey,
      ),
  );
}

export function visibleCatalogHostSessions(
  catalogId: string,
  host: SessionCatalogHost,
  params: SessionCatalogGroupsParams,
): readonly SessionCatalogSession[] {
  const grouped =
    params.host.hiddenSessionCatalogFolderKeys.size > 0
      ? catalogFolderGroups(host.sessions, params.snapshot.projectGrouping)
      : null;
  return grouped
    ? [
        ...visibleCatalogFolders(catalogId, host.hostId, grouped.groups, params).flatMap(
          (folder) => folder.sessions,
        ),
        ...grouped.ungrouped,
      ]
    : host.sessions;
}

async function moveCatalog(
  host: SessionCatalogGroupsParams["host"],
  request: SessionsCatalogMoveParams,
): Promise<void> {
  const mutation = host.sessionData.beginSessionMutation();
  if (!mutation) {
    return;
  }
  const scope = { ...mutation, catalogGeneration: host.sessionData.sessionScopeGeneration };
  try {
    const result = await host.sessionData.moveSessionCatalog(scope, request);
    if (result?.warning) {
      showToast({ message: result.warning });
    }
  } catch (error) {
    if (
      host.sessionData.isSessionMutationScopeCurrent(scope) &&
      scope.catalogGeneration === host.sessionData.sessionScopeGeneration
    ) {
      showToast({ message: formatUiError(error) });
    }
  }
}

async function reorderCatalog(
  host: SessionCatalogGroupsParams["host"],
  request: SessionsCatalogReorderParams,
): Promise<void> {
  const mutation = host.sessionData.beginSessionMutation();
  if (!mutation) {
    return;
  }
  const scope = { ...mutation, catalogGeneration: host.sessionData.sessionScopeGeneration };
  try {
    await host.sessionData.reorderSessionCatalog(scope, request);
  } catch (error) {
    if (
      host.sessionData.isSessionMutationScopeCurrent(scope) &&
      scope.catalogGeneration === host.sessionData.sessionScopeGeneration
    ) {
      showToast({ message: formatUiError(error) });
    }
  }
}

/** Folder groups of one catalog host: all of them, and the ones the sidebar renders. */
export function createCatalogHostFolders(
  readHost: () => SessionCatalogHost,
  identity: () => CatalogIdentity,
  params: SessionCatalogGroupsParams,
) {
  const allProjectGroups = createMemo(() =>
    catalogFolderGroups(readHost().sessions, params.snapshot.projectGrouping),
  );
  // Hidden folders leave only the rendered list; reordering still sees every custom folder.
  const projectGroups = createMemo(() => {
    const grouped = allProjectGroups();
    return grouped && params.host.hiddenSessionCatalogFolderKeys.size > 0
      ? {
          ...grouped,
          groups: visibleCatalogFolders(
            identity().catalogId,
            identity().hostId,
            grouped.groups,
            params,
          ),
        }
      : grouped;
  });
  return { allProjectGroups, projectGroups };
}

/** Drag state of one catalog host: custom folder order, row order and moves between folders. */
export function createCatalogHostReorder(
  readCatalog: () => SessionCatalog,
  identity: () => CatalogIdentity,
  allProjectGroups: () => CatalogFolderGroups | null,
  params: SessionCatalogGroupsParams,
) {
  // Custom folders and their rows follow the provider's persisted order, so
  // dragging them is offered only when the provider can persist a new one.
  const reorderAccess = createMemo(() =>
    params.host.readSessionMutationAccess({
      method: "sessions.catalog.reorder",
      requiredScope: "operator.write",
    }),
  );
  const canReorder = createMemo(
    () => readCatalog().capabilities.reorder === true && reorderAccess().allowed,
  );
  // A provider that can move rows takes a row dropped on another custom folder.
  const moveAccess = createMemo(() =>
    params.host.readSessionMutationAccess({
      method: "sessions.catalog.move",
      requiredScope: "operator.write",
    }),
  );
  const canMove = createMemo(
    () => readCatalog().capabilities.move === true && moveAccess().allowed,
  );
  const canDragRows = () => canReorder() || canMove();
  const [moveDropFolder, setMoveDropFolder] = createSignal<string | null>(null);
  const [draggingFolder, setDraggingFolder] = createSignal<string | null>(null);
  const [folderDropTarget, setFolderDropTarget] = createSignal<{
    group: string;
    position: DropPosition;
  } | null>(null);
  let rowDropElement: HTMLElement | null = null;
  const setRowDropTarget = (element: HTMLElement | null, position?: DropPosition) => {
    if (rowDropElement && rowDropElement !== element) {
      rowDropElement.classList.remove(ROW_DROP_CLASSES.before, ROW_DROP_CLASSES.after);
    }
    rowDropElement = element;
    if (element && position) {
      element.classList.toggle(ROW_DROP_CLASSES.before, position === "before");
      element.classList.toggle(ROW_DROP_CLASSES.after, position === "after");
    }
  };
  const acceptsDrag = (
    payload: CatalogReorderDragPayload | null,
    kind: CatalogReorderDragPayload["kind"],
  ): payload is CatalogReorderDragPayload =>
    (kind === "row" ? canDragRows() : canReorder()) &&
    payload?.kind === kind &&
    payload.catalogId === identity().catalogId &&
    payload.hostId === identity().hostId;
  const customFolderOrder = () =>
    (allProjectGroups()?.groups ?? [])
      .filter((group) => group.kind === "custom")
      .map((group) => group.label);
  const finishReorderDrag = () => {
    finishCatalogReorderDrag();
    setDraggingFolder(null);
    setFolderDropTarget(null);
    setMoveDropFolder(null);
    setRowDropTarget(null);
  };
  const reorder = (target: SessionsCatalogReorderParams["target"]) =>
    void reorderCatalog(params.host, {
      catalogId: identity().catalogId,
      hostId: identity().hostId,
      agentId: params.snapshot.newSessionAgentId,
      target,
    });
  const move = (request: Pick<SessionsCatalogMoveParams, "threadId" | "group" | "threadIds">) =>
    void moveCatalog(params.host, {
      catalogId: identity().catalogId,
      hostId: identity().hostId,
      agentId: params.snapshot.newSessionAgentId,
      ...request,
    });

  /** Drag handlers of one folder (custom folders only; other groups ignore drags). */
  function folderDrag({
    customFolder,
    rows,
  }: {
    customFolder: string | undefined;
    rows: () => readonly SessionCatalogSession[];
  }) {
    const folderReorderable = () => customFolder !== undefined && canReorder();
    const folderClass = createMemo(() => {
      const dropTarget = folderDropTarget();
      return [
        "sidebar-session-catalog-project",
        customFolder !== undefined && draggingFolder() === customFolder
          ? "sidebar-session-catalog-project--dragging"
          : "",
        customFolder !== undefined && dropTarget?.group === customFolder
          ? `sidebar-session-catalog-project--drop-${dropTarget.position}`
          : "",
        customFolder !== undefined && moveDropFolder() === customFolder
          ? "sidebar-session-catalog-project--drop-into"
          : "",
      ]
        .filter(Boolean)
        .join(" ");
    });
    const rowDrop: CatalogFolderRowDrop = {
      identity: {
        get catalogId() {
          return identity().catalogId;
        },
        get hostId() {
          return identity().hostId;
        },
      },
      folder: customFolder,
      rows,
      accepts: (payload) => acceptsDrag(payload, "row"),
      canReorder,
      canMove,
      setRowDropTarget,
      setMoveDropFolder,
      finish: finishReorderDrag,
      reorder,
      move,
    };
    return {
      folderClass,
      draggable: () => (folderReorderable() ? "true" : undefined),
      onMouseDown: (event: MouseEvent) => {
        // Only the folder header starts a folder drag; rows own their drags.
        (event.currentTarget as HTMLElement).toggleAttribute(
          "data-catalog-folder-drag-armed",
          Boolean((event.target as Element).closest(".sidebar-session-catalog-project__head")),
        );
      },
      onDragStart: (event: DragEvent) => {
        const folder = event.currentTarget as HTMLElement;
        if (event.target !== folder) {
          return;
        }
        const armed = folder.hasAttribute("data-catalog-folder-drag-armed");
        folder.removeAttribute("data-catalog-folder-drag-armed");
        if (!armed || !folderReorderable() || !customFolder || !event.dataTransfer) {
          event.preventDefault();
          return;
        }
        event.stopPropagation();
        writeCatalogReorderDragData(event.dataTransfer, {
          kind: "group",
          catalogId: identity().catalogId,
          hostId: identity().hostId,
          group: customFolder,
        });
        setDraggingFolder(customFolder);
      },
      onDragEnd: (event: DragEvent) => {
        if (event.target === event.currentTarget) {
          finishReorderDrag();
        }
      },
      onDragOver: (event: DragEvent) => {
        if (catalogFolderMoveDragOver(rowDrop, event)) {
          return;
        }
        const payload = activeCatalogReorderDragData(event.dataTransfer);
        if (!acceptsDrag(payload, "group") || !customFolder) {
          return;
        }
        event.stopPropagation();
        if (payload.group === customFolder) {
          setFolderDropTarget(null);
          return;
        }
        event.preventDefault();
        if (event.dataTransfer) {
          event.dataTransfer.dropEffect = "move";
        }
        setFolderDropTarget({
          group: customFolder,
          position: dropPosition(event, event.currentTarget as Element),
        });
      },
      onDragLeave: (event: DragEvent) => {
        const current = event.currentTarget as HTMLElement;
        if (event.relatedTarget instanceof Node && current.contains(event.relatedTarget)) {
          return;
        }
        if (folderDropTarget()?.group === customFolder) {
          setFolderDropTarget(null);
        }
        if (moveDropFolder() === customFolder) {
          setMoveDropFolder(null);
        }
      },
      onDrop: (event: DragEvent) => {
        if (catalogFolderMoveDrop(rowDrop, event)) {
          return;
        }
        const payload = readCatalogReorderDragData(event.dataTransfer);
        if (!acceptsDrag(payload, "group") || !customFolder) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        const order = moveCatalogOrderEntry(
          customFolderOrder(),
          payload.group,
          customFolder,
          dropPosition(event, event.currentTarget as Element),
        );
        finishReorderDrag();
        if (order) {
          reorder({ kind: "groups", order });
        }
      },
      onRowsDragOver: (event: DragEvent) => catalogRowDragOver(rowDrop, event),
      onRowsDragLeave: (event: DragEvent) => {
        const current = event.currentTarget as HTMLElement;
        if (!(event.relatedTarget instanceof Node) || !current.contains(event.relatedTarget)) {
          setRowDropTarget(null);
        }
      },
      onRowsDrop: (event: DragEvent) => catalogRowDrop(rowDrop, event),
    };
  }

  /** Drag handlers of one row; only rows of a custom folder (`reorderGroup`) are draggable. */
  function rowDrag(
    reorderGroup: string | undefined,
    catalogKey: () => { catalogId: string; hostId: string; threadId: string },
  ) {
    const reorderable = createMemo(() => reorderGroup !== undefined && canDragRows());
    const reorderPayload = (group: string): CatalogReorderDragPayload => ({
      kind: "row",
      catalogId: catalogKey().catalogId,
      hostId: catalogKey().hostId,
      group,
      threadId: catalogKey().threadId,
    });
    return {
      draggable: () => (reorderable() ? "true" : undefined),
      linkDraggable: () => (reorderable() ? "false" : undefined),
      onDragStart: (event: DragEvent) => {
        if (!reorderGroup || !reorderable() || !event.dataTransfer) {
          return;
        }
        event.stopPropagation();
        writeCatalogReorderDragData(event.dataTransfer, reorderPayload(reorderGroup));
      },
      onDragEnd: () => {
        if (reorderGroup) {
          finishReorderDrag();
        }
      },
      catalogReorder: () =>
        reorderGroup && reorderable()
          ? { payload: reorderPayload(reorderGroup), onFinish: finishReorderDrag }
          : undefined,
    };
  }

  return { folderDrag, rowDrag };
}
