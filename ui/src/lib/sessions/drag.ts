// Private MIME keeps stray text and file drags from becoming session actions.
export const SESSION_DRAG_MIME = "application/x-openclaw-session-key";
const SIDEBAR_SECTION_DRAG_MIME = "application/x-openclaw-session-group";
const SIDEBAR_ROUTE_DRAG_MIME = "application/x-openclaw-sidebar-route";

function createDragHandlers(mime: string, copyMove = false) {
  return {
    write: (dataTransfer: DataTransfer, value: string): void => {
      dataTransfer.setData(mime, value);
      if (copyMove) {
        // Sidebar sessions can move between groups or copy into a chat split pane.
        dataTransfer.setData("text/plain", value);
      }
      dataTransfer.effectAllowed = copyMove ? "copyMove" : "move";
    },
    read: (dataTransfer: DataTransfer | null): string | null => {
      return dataTransfer?.getData(mime).trim() || null;
    },
    active: (dataTransfer: DataTransfer | null): boolean => {
      return Array.from(dataTransfer?.types ?? []).includes(mime);
    },
  };
}

const sessionDrag = createDragHandlers(SESSION_DRAG_MIME, true);
const sectionDrag = createDragHandlers(SIDEBAR_SECTION_DRAG_MIME);
const routeDrag = createDragHandlers(SIDEBAR_ROUTE_DRAG_MIME);

export const writeSessionDragData = sessionDrag.write;
export const readSessionDragData = sessionDrag.read;
export const sessionDragActive = sessionDrag.active;
export const writeSidebarSectionDragData = sectionDrag.write;
export const readSidebarSectionDragData = sectionDrag.read;
export const sidebarSectionDragActive = sectionDrag.active;
export const writeSidebarRouteDragData = routeDrag.write;
export const readSidebarRouteDragData = routeDrag.read;
export const sidebarRouteDragActive = routeDrag.active;

const CATALOG_REORDER_DRAG_MIME = "application/x-openclaw-catalog-reorder";

/** A catalog folder (`group`) or row being dragged to a new position in its host. */
export type CatalogReorderDragPayload = {
  kind: "group" | "row";
  catalogId: string;
  hostId: string;
  /** Folder name: the dragged folder, or the folder that owns the dragged row. */
  group: string;
  threadId?: string;
};

const catalogReorderDrag = createDragHandlers(CATALOG_REORDER_DRAG_MIME);
// Browsers hide transferred data during dragover; drop targets read the
// payload recorded at dragstart to decide whether they accept the drag.
let activeCatalogReorderDrag: CatalogReorderDragPayload | null = null;

function parseCatalogReorderDragPayload(raw: string | null): CatalogReorderDragPayload | null {
  if (!raw) {
    return null;
  }
  try {
    const value = JSON.parse(raw) as Partial<CatalogReorderDragPayload> | null;
    if (
      (value?.kind !== "group" && value?.kind !== "row") ||
      typeof value.catalogId !== "string" ||
      typeof value.hostId !== "string" ||
      typeof value.group !== "string" ||
      (value.kind === "row" && typeof value.threadId !== "string")
    ) {
      return null;
    }
    return {
      kind: value.kind,
      catalogId: value.catalogId,
      hostId: value.hostId,
      group: value.group,
      ...(value.kind === "row" ? { threadId: value.threadId } : {}),
    };
  } catch {
    return null;
  }
}

export function writeCatalogReorderDragData(
  dataTransfer: DataTransfer,
  payload: CatalogReorderDragPayload,
): void {
  catalogReorderDrag.write(dataTransfer, JSON.stringify(payload));
  activeCatalogReorderDrag = payload;
}

export function readCatalogReorderDragData(
  dataTransfer: DataTransfer | null,
): CatalogReorderDragPayload | null {
  return parseCatalogReorderDragPayload(catalogReorderDrag.read(dataTransfer));
}

/** The payload of the catalog reorder drag in progress, when it is one. */
export function activeCatalogReorderDragData(
  dataTransfer: DataTransfer | null,
): CatalogReorderDragPayload | null {
  return catalogReorderDrag.active(dataTransfer) ? activeCatalogReorderDrag : null;
}

export function finishCatalogReorderDrag(): void {
  activeCatalogReorderDrag = null;
}
