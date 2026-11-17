import { moveCatalogOrderEntry } from "../lib/sessions/catalog-reorder.ts";
import {
  activeCatalogReorderDragData,
  readCatalogReorderDragData,
  writeCatalogReorderDragData,
  type CatalogReorderDragPayload,
} from "../lib/sessions/drag.ts";
import {
  catalogFolderMoveDragOver,
  catalogFolderMoveDrop,
  dropPosition,
  type CatalogFolderRowDrop,
  type DropPosition,
} from "./app-sidebar-session-catalog-drag.ts";

export type CatalogFolderDropTarget = { group: string; position: DropPosition };

export type CatalogFolderDrag = {
  /** Row drops on this folder; its `folder` is the custom folder, undefined for other kinds. */
  rowDrop: CatalogFolderRowDrop;
  reorderable: () => boolean;
  acceptsGroup: (payload: CatalogReorderDragPayload | null) => payload is CatalogReorderDragPayload;
  setDragging: (folder: string | null) => void;
  dropTarget: () => CatalogFolderDropTarget | null;
  setDropTarget: (target: CatalogFolderDropTarget | null) => void;
  moveDropFolder: () => string | null;
  folderOrder: () => readonly string[];
};

/**
 * Drag handlers of one catalog folder: dragging a custom folder by its header to reorder folders,
 * and dropping rows on a folder to move them (`capabilities.move`).
 */
export function catalogFolderDragHandlers(drag: CatalogFolderDrag) {
  const { rowDrop } = drag;
  const folder = rowDrop.folder;
  return {
    onMouseDown: (event: MouseEvent) => {
      // Only the folder header starts a folder drag; rows own their drags.
      (event.currentTarget as HTMLElement).toggleAttribute(
        "data-catalog-folder-drag-armed",
        Boolean((event.target as Element).closest(".sidebar-session-catalog-project__head")),
      );
    },
    onDragStart: (event: DragEvent) => {
      const element = event.currentTarget as HTMLElement;
      if (event.target !== element) {
        return;
      }
      const armed = element.hasAttribute("data-catalog-folder-drag-armed");
      element.removeAttribute("data-catalog-folder-drag-armed");
      if (!armed || !drag.reorderable() || !folder || !event.dataTransfer) {
        event.preventDefault();
        return;
      }
      event.stopPropagation();
      writeCatalogReorderDragData(event.dataTransfer, {
        kind: "group",
        catalogId: rowDrop.identity.catalogId,
        hostId: rowDrop.identity.hostId,
        group: folder,
      });
      drag.setDragging(folder);
    },
    onDragEnd: (event: DragEvent) => {
      if (event.target === event.currentTarget) {
        rowDrop.finish();
      }
    },
    onDragOver: (event: DragEvent) => {
      if (catalogFolderMoveDragOver(rowDrop, event)) {
        return;
      }
      const payload = activeCatalogReorderDragData(event.dataTransfer);
      if (!drag.acceptsGroup(payload) || !folder) {
        return;
      }
      event.stopPropagation();
      if (payload.group === folder) {
        drag.setDropTarget(null);
        return;
      }
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = "move";
      }
      drag.setDropTarget({
        group: folder,
        position: dropPosition(event, event.currentTarget as Element),
      });
    },
    onDragLeave: (event: DragEvent) => {
      const current = event.currentTarget as HTMLElement;
      if (event.relatedTarget instanceof Node && current.contains(event.relatedTarget)) {
        return;
      }
      if (drag.dropTarget()?.group === folder) {
        drag.setDropTarget(null);
      }
      if (drag.moveDropFolder() === folder) {
        rowDrop.setMoveDropFolder(null);
      }
    },
    onDrop: (event: DragEvent) => {
      if (catalogFolderMoveDrop(rowDrop, event)) {
        return;
      }
      const payload = readCatalogReorderDragData(event.dataTransfer);
      if (!drag.acceptsGroup(payload) || !folder) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const order = moveCatalogOrderEntry(
        [...drag.folderOrder()],
        payload.group,
        folder,
        dropPosition(event, event.currentTarget as Element),
      );
      rowDrop.finish();
      if (order) {
        rowDrop.reorder({ kind: "groups", order });
      }
    },
  };
}
