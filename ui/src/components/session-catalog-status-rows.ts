import type { SessionCatalog } from "../../../packages/gateway-protocol/src/index.ts";
import { SIDEBAR_SESSION_ROSTER_LIMIT } from "../../../src/shared/session-list-limits.ts";
import type { GatewaySessionRow } from "../api/types.ts";
import type { ApplicationContext } from "../app/context.ts";
import { canCallGatewayMethod } from "../lib/gateway-methods.ts";
import type {
  SessionCapability,
  SessionConnectionScope,
  SessionListScope,
} from "../lib/sessions/session-capability.ts";

/**
 * One all-agent window of active sidebar rows. Owned by the session capability, so the
 * broad `sessions.changed` stream keeps it current and its event refreshes stay paced.
 */
export const CATALOG_STATUS_LIST_QUERY: SessionListScope = Object.freeze({
  source: "sidebar",
  excludeDock: true,
  archivedFilter: "active",
  limit: SIDEBAR_SESSION_ROSTER_LIMIT,
  rowMode: "sidebar",
  includeDerivedTitles: true,
  includeLastMessage: true,
});

type CatalogStatusRowsOwner = {
  readonly context: ApplicationContext | undefined;
  readonly sessionDataHostConnected: boolean;
  requestSessionDataUpdate(): void;
};

type Binding = {
  sessions: SessionCapability;
  connection: SessionConnectionScope;
  observation?: ReturnType<SessionCapability["observeList"]>;
};

const EMPTY: readonly GatewaySessionRow[] = [];

function catalogsAdoptSessions(catalogs: readonly SessionCatalog[]): boolean {
  return catalogs.some((catalog) =>
    catalog.hosts.some((host) => host.sessions.some((session) => Boolean(session.sessionKey))),
  );
}

/**
 * Fork (F58): a catalog such as the Projects tree lists the sessions of every agent, while the
 * sidebar's session list holds only the selected agent. These rows back the other agents'
 * catalog rows, so their running, unread and active-run markers survive an agent switch.
 */
export class SessionCatalogStatusRows {
  rows: readonly GatewaySessionRow[] = EMPTY;
  private binding: Binding | null = null;

  constructor(private readonly owner: CatalogStatusRowsOwner) {}

  synchronize(catalogs: readonly SessionCatalog[]): void {
    const context = this.owner.context;
    const wanted =
      context !== undefined &&
      this.owner.sessionDataHostConnected &&
      canCallGatewayMethod(context.gateway.snapshot, "sessions.list", "operator.read") &&
      catalogsAdoptSessions(catalogs);
    const current = this.binding;
    if (
      current &&
      wanted &&
      current.sessions === context.sessions &&
      context.sessions.isConnectionScopeCurrent(current.connection)
    ) {
      return;
    }
    // Keep the previous rows until the replacement window answers.
    this.retire(!wanted);
    if (!wanted) {
      return;
    }
    const connection = context.sessions.captureConnectionScope();
    if (!connection) {
      return;
    }
    const binding: Binding = { sessions: context.sessions, connection };
    // The observation publishes a held snapshot synchronously, so the binding is current first.
    this.binding = binding;
    binding.observation = context.sessions.observeList(CATALOG_STATUS_LIST_QUERY, (snapshot) => {
      if (this.binding !== binding || !snapshot.result) {
        return;
      }
      if (snapshot.result.sessions !== this.rows) {
        this.rows = snapshot.result.sessions;
        this.owner.requestSessionDataUpdate();
      }
    });
    void binding.observation?.refresh().catch(() => undefined);
  }

  dispose(): void {
    this.retire(true);
  }

  private retire(clearRows: boolean): void {
    const previous = this.binding;
    this.binding = null;
    previous?.observation?.dispose();
    if (clearRows && this.rows !== EMPTY) {
      this.rows = EMPTY;
      this.owner.requestSessionDataUpdate();
    }
  }
}

const stores = new WeakMap<CatalogStatusRowsOwner, SessionCatalogStatusRows>();

/** The session data owner's status rows, created on first use. */
export function catalogStatusRows(owner: CatalogStatusRowsOwner): SessionCatalogStatusRows {
  let store = stores.get(owner);
  if (!store) {
    store = new SessionCatalogStatusRows(owner);
    stores.set(owner, store);
  }
  return store;
}
