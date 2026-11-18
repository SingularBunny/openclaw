import type {
  SessionsCatalogMoveParams,
  SessionsCatalogMoveResult,
  SessionsCatalogReorderParams,
} from "../../../packages/gateway-protocol/src/index.ts";
import { moveSessionCatalogs, reorderSessionCatalogs } from "../lib/sessions/catalog-reorder.ts";
import type {
  SidebarCatalogSessionMutationScope,
  SidebarSessionMutationScope,
} from "./app-sidebar-session-types.ts";
import type { SessionCatalogDataOwner } from "./session-data-catalog.ts";

// Fork: custom folder order and moves between folders of a session catalog.

/**
 * Shows the new folder or row order at once, persists it through the catalog
 * provider, and restores the previous rows when the Gateway rejects it.
 */
export async function reorderSessionCatalog(
  owner: SessionCatalogDataOwner & {
    isSessionMutationScopeCurrent(scope: SidebarSessionMutationScope): boolean;
    invalidateSessionCatalogs(): void;
  },
  scope: SidebarCatalogSessionMutationScope,
  params: SessionsCatalogReorderParams,
): Promise<void> {
  const generation = scope.catalogGeneration;
  const isCurrent = () =>
    generation === owner.sessionScopeGeneration && owner.isSessionMutationScopeCurrent(scope);
  if (!isCurrent()) {
    return;
  }
  const previous = owner.sessionCatalogs;
  owner.sessionCatalogs = reorderSessionCatalogs(previous, params);
  owner.sessionCatalogRevision += 1;
  owner.requestSessionDataUpdate();
  try {
    await scope.client.request("sessions.catalog.reorder", params);
  } catch (error) {
    if (isCurrent()) {
      owner.sessionCatalogs = previous;
      owner.sessionCatalogRevision += 1;
      owner.requestSessionDataUpdate();
    }
    throw error;
  }
  if (isCurrent()) {
    owner.invalidateSessionCatalogs();
  }
}

/**
 * Shows a row in its new folder at once, asks the catalog provider to move it,
 * and restores the previous rows when the Gateway rejects the move.
 */
export async function moveSessionCatalog(
  owner: SessionCatalogDataOwner & {
    isSessionMutationScopeCurrent(scope: SidebarSessionMutationScope): boolean;
    invalidateSessionCatalogs(): void;
  },
  scope: SidebarCatalogSessionMutationScope,
  params: SessionsCatalogMoveParams,
): Promise<SessionsCatalogMoveResult | null> {
  const generation = scope.catalogGeneration;
  const isCurrent = () =>
    generation === owner.sessionScopeGeneration && owner.isSessionMutationScopeCurrent(scope);
  if (!isCurrent()) {
    return null;
  }
  const previous = owner.sessionCatalogs;
  owner.sessionCatalogs = moveSessionCatalogs(previous, params);
  owner.sessionCatalogRevision += 1;
  owner.requestSessionDataUpdate();
  let result: SessionsCatalogMoveResult;
  try {
    result = await scope.client.request<SessionsCatalogMoveResult>("sessions.catalog.move", params);
  } catch (error) {
    if (isCurrent()) {
      owner.sessionCatalogs = previous;
      owner.sessionCatalogRevision += 1;
      owner.requestSessionDataUpdate();
    }
    throw error;
  }
  if (isCurrent()) {
    owner.invalidateSessionCatalogs();
  }
  return result;
}
