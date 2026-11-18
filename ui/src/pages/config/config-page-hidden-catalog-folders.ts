import {
  loadStoredHiddenSessionCatalogFolders,
  SIDEBAR_HIDDEN_SESSION_CATALOG_FOLDERS_CHANGED_EVENT,
} from "../../components/app-sidebar-session-types.ts";
import { listen } from "../../lib/reactive/listener.ts";

/** Fork: catalog folders hidden from the sidebar, as Settings lists them. */
export function createConfigPageHiddenCatalogFolders(invalidate: () => void) {
  let folders = loadStoredHiddenSessionCatalogFolders();
  const changed = () => {
    folders = loadStoredHiddenSessionCatalogFolders();
    invalidate();
  };
  return {
    get folders() {
      return folders;
    },
    changed,
    listen: () => listen(window, SIDEBAR_HIDDEN_SESSION_CATALOG_FOLDERS_CHANGED_EVENT, changed),
  };
}
