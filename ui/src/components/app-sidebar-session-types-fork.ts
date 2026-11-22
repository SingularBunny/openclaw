// Fork: hidden folders of a session catalog section in the sidebar (folder menu, undo, and
// Settings). Kept out of app-sidebar-session-types.ts so upstream ports touch less.
import { getSafeLocalStorage } from "../local-storage.ts";

const SIDEBAR_HIDDEN_SESSION_CATALOG_FOLDERS_STORAGE_KEY =
  "openclaw:sidebar:sessions:hidden-catalog-folders";
export const SIDEBAR_HIDDEN_SESSION_CATALOG_FOLDERS_CHANGED_EVENT =
  "openclaw:sidebar-hidden-catalog-folders-changed";

/** One hidden folder of a catalog section; labels are kept so Settings can name it offline. */
export type SidebarHiddenCatalogFolder = {
  readonly catalogId: string;
  readonly folderId: string;
  readonly catalogLabel: string;
  readonly label: string;
};

function storedStringField(entry: unknown, name: string): string {
  const value: unknown =
    typeof entry === "object" && entry !== null ? Reflect.get(entry, name) : undefined;
  return typeof value === "string" ? value : "";
}

export function sessionCatalogFolderKey(catalogId: string, folderId: string): string {
  return `${catalogId}\u0000${folderId}`;
}

export function loadStoredHiddenSessionCatalogFolders(): readonly SidebarHiddenCatalogFolder[] {
  try {
    const raw = getSafeLocalStorage()?.getItem(SIDEBAR_HIDDEN_SESSION_CATALOG_FOLDERS_STORAGE_KEY);
    const parsed: unknown = raw == null ? [] : JSON.parse(raw);
    const folders = new Map<string, SidebarHiddenCatalogFolder>();
    for (const entry of Array.isArray(parsed) ? parsed : []) {
      const catalogId = storedStringField(entry, "catalogId");
      const folderId = storedStringField(entry, "folderId");
      if (!catalogId || !folderId) {
        continue;
      }
      folders.set(sessionCatalogFolderKey(catalogId, folderId), {
        catalogId,
        folderId,
        catalogLabel: storedStringField(entry, "catalogLabel") || catalogId,
        label: storedStringField(entry, "label") || folderId,
      });
    }
    return [...folders.values()];
  } catch {
    return [];
  }
}

export function loadStoredHiddenSessionCatalogFolderKeys(): ReadonlySet<string> {
  return new Set(
    loadStoredHiddenSessionCatalogFolders().map((folder) =>
      sessionCatalogFolderKey(folder.catalogId, folder.folderId),
    ),
  );
}

/** Hide/show of one catalog folder, shared by the folder menu, undo, and Settings. */
export function setStoredSessionCatalogFolderHidden(
  folder: SidebarHiddenCatalogFolder,
  hidden: boolean,
) {
  const key = sessionCatalogFolderKey(folder.catalogId, folder.folderId);
  const next = loadStoredHiddenSessionCatalogFolders().filter(
    (entry) => sessionCatalogFolderKey(entry.catalogId, entry.folderId) !== key,
  );
  if (hidden) {
    next.push(folder);
  }
  try {
    getSafeLocalStorage()?.setItem(
      SIDEBAR_HIDDEN_SESSION_CATALOG_FOLDERS_STORAGE_KEY,
      JSON.stringify(next),
    );
  } catch {
    // Storage can be unavailable in private browsing; the folder simply is not remembered.
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(SIDEBAR_HIDDEN_SESSION_CATALOG_FOLDERS_CHANGED_EVENT));
  }
}
