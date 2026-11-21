// Fork: drag to reorder catalog folders and rows in the sidebar.
// Kept out of drag.ts so upstream changes there merge without conflicts.
import { createDragHandlers } from "./drag.ts";

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
