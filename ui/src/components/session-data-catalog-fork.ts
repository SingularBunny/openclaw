// Fork (F31): catalog rows stay on screen across agent switches.
// Kept out of session-data-catalog.ts so upstream changes there merge without conflicts.
import { canCallGatewayMethod } from "../lib/gateway-methods.ts";
import { createPanelRefreshStatus } from "./panel-refresh-status-state.ts";
import type { SessionCatalogDataOwner } from "./session-data-catalog.ts";

/**
 * Catalogs such as the Projects tree list the sessions of every agent, so a switch to
 * another agent's chat keeps the rows on screen and re-reads them in the background (the refresh
 * replaces them). Rows go only when catalog access is gone. Expanded pages are not carried over:
 * their cursors belong to the previous agent's listing.
 */
export function retainSessionCatalogRows(
  owner: SessionCatalogDataOwner,
  nextCatalogAgentId: string | null,
  scopeAgentChanged: boolean,
): void {
  const snapshot = owner.context?.gateway.snapshot;
  const accessRevoked =
    !owner.context ||
    (nextCatalogAgentId === null &&
      snapshot?.phase === "connected" &&
      !canCallGatewayMethod(snapshot, "sessions.catalog.list", "operator.read"));
  owner.sessionCatalogRefreshStatus =
    !accessRevoked && owner.sessionCatalogs.length > 0
      ? { ...owner.sessionCatalogRefreshStatus, error: null, awaitingGateway: false }
      : createPanelRefreshStatus();
  if (scopeAgentChanged) {
    owner.sessionCatalogPageDepths.clear();
  }
  if (scopeAgentChanged && accessRevoked) {
    owner.sessionCatalogs = [];
  }
}
