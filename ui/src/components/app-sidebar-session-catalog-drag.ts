import type {
  SessionCatalogSession,
  SessionsCatalogMoveParams,
  SessionsCatalogReorderParams,
} from "../../../packages/gateway-protocol/src/index.ts";
import { buildCatalogSessionKey } from "../lib/sessions/catalog-key.ts";
import { insertCatalogOrderEntry, moveCatalogOrderEntry } from "../lib/sessions/catalog-reorder.ts";
import {
  activeCatalogReorderDragData,
  readCatalogReorderDragData,
  type CatalogReorderDragPayload,
} from "../lib/sessions/drag.ts";

export type DropPosition = "before" | "after";

export const ROW_DROP_CLASSES = {
  before: "sidebar-recent-session--catalog-drop-before",
  after: "sidebar-recent-session--catalog-drop-after",
} as const;

export function dropPosition(event: DragEvent, element: Element): DropPosition {
  const bounds = element.getBoundingClientRect();
  return event.clientY < bounds.top + bounds.height / 2 ? "before" : "after";
}

/** Drop handling for the rows of one custom folder of a catalog host. */
export type CatalogFolderRowDrop = {
  identity: { catalogId: string; hostId: string };
  /** The custom folder these rows belong to; undefined for project or person groups. */
  folder: string | undefined;
  rows: () => readonly SessionCatalogSession[];
  accepts: (payload: CatalogReorderDragPayload | null) => payload is CatalogReorderDragPayload;
  canReorder: () => boolean;
  canMove: () => boolean;
  setRowDropTarget: (element: HTMLElement | null, position?: DropPosition) => void;
  setMoveDropFolder: (folder: string | null) => void;
  finish: () => void;
  reorder: (target: SessionsCatalogReorderParams["target"]) => void;
  move: (request: Pick<SessionsCatalogMoveParams, "threadId" | "group" | "threadIds">) => void;
};

function rowDropTarget(drop: CatalogFolderRowDrop, event: DragEvent) {
  const element = (event.target as Element | null)?.closest<HTMLElement>(
    "[data-catalog-session-key]",
  );
  if (!element || !event.currentTarget) {
    return null;
  }
  const key = element.dataset.catalogSessionKey;
  const session = drop.rows().find(
    (candidate) =>
      buildCatalogSessionKey({
        catalogId: drop.identity.catalogId,
        hostId: drop.identity.hostId,
        threadId: candidate.threadId,
        ...(candidate.sourceHomeId ? { sourceHomeId: candidate.sourceHomeId } : {}),
      }) === key,
  );
  return session ? { element, threadId: session.threadId } : null;
}

const threadOrder = (drop: CatalogFolderRowDrop) => [
  ...new Set(drop.rows().map((session) => session.threadId)),
];

/** A row dragged over the folder's rows: its own folder reorders, another folder moves. */
export function catalogRowDragOver(drop: CatalogFolderRowDrop, event: DragEvent): void {
  const payload = activeCatalogReorderDragData(event.dataTransfer);
  if (!drop.accepts(payload)) {
    return;
  }
  event.stopPropagation();
  const target = rowDropTarget(drop, event);
  const allowed =
    payload.group === drop.folder ? drop.canReorder() : drop.canMove() && drop.folder !== undefined;
  drop.setMoveDropFolder(null);
  if (!allowed || !target || target.threadId === payload.threadId) {
    drop.setRowDropTarget(null);
    return;
  }
  event.preventDefault();
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = "move";
  }
  drop.setRowDropTarget(target.element, dropPosition(event, target.element));
}

export function catalogRowDrop(drop: CatalogFolderRowDrop, event: DragEvent): void {
  const payload = readCatalogReorderDragData(event.dataTransfer);
  const folder = drop.folder;
  if (!drop.accepts(payload) || !folder || !payload.threadId) {
    return;
  }
  const own = payload.group === folder;
  if (own ? !drop.canReorder() : !drop.canMove()) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  const target = rowDropTarget(drop, event);
  const position = target ? dropPosition(event, target.element) : "after";
  const order = target
    ? (own ? moveCatalogOrderEntry : insertCatalogOrderEntry)(
        threadOrder(drop),
        payload.threadId,
        target.threadId,
        position,
      )
    : null;
  drop.finish();
  if (!own) {
    drop.move({
      threadId: payload.threadId,
      group: folder,
      ...(order ? { threadIds: order } : {}),
    });
  } else if (order) {
    drop.reorder({ kind: "sessions", group: folder, threadIds: order });
  }
}

/**
 * A row from another folder over this folder outside its rows (the header, or the
 * collapsed folder) moves into it. Returns whether the event was taken.
 */
export function catalogFolderMoveDragOver(drop: CatalogFolderRowDrop, event: DragEvent): boolean {
  const payload = activeCatalogReorderDragData(event.dataTransfer);
  if (!drop.accepts(payload) || !drop.canMove() || !drop.folder) {
    return false;
  }
  if (payload.group !== drop.folder) {
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "move";
    }
    drop.setRowDropTarget(null);
    drop.setMoveDropFolder(drop.folder);
  }
  event.stopPropagation();
  return true;
}

export function catalogFolderMoveDrop(drop: CatalogFolderRowDrop, event: DragEvent): boolean {
  const payload = readCatalogReorderDragData(event.dataTransfer);
  if (!drop.accepts(payload) || !drop.canMove() || !drop.folder || !payload.threadId) {
    return false;
  }
  event.stopPropagation();
  if (payload.group !== drop.folder) {
    event.preventDefault();
    drop.finish();
    drop.move({ threadId: payload.threadId, group: drop.folder });
  }
  return true;
}
