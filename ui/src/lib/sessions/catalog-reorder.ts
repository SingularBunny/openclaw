import type {
  SessionCatalog,
  SessionCatalogSession,
  SessionsCatalogReorderParams,
} from "../../../../packages/gateway-protocol/src/index.ts";

type ReorderTarget = SessionsCatalogReorderParams["target"];

function customGroupOf(session: SessionCatalogSession): string | undefined {
  return session.customGroup?.trim() || undefined;
}

// Reorders only the rows the target selects and writes them back into the
// slots those rows already held, so unrelated rows keep their positions.
function reorderSlots(
  sessions: readonly SessionCatalogSession[],
  selects: (session: SessionCatalogSession) => boolean,
  rank: (session: SessionCatalogSession) => number,
): SessionCatalogSession[] {
  const slots: number[] = [];
  const selected: SessionCatalogSession[] = [];
  sessions.forEach((session, index) => {
    if (selects(session)) {
      slots.push(index);
      selected.push(session);
    }
  });
  // Array sort is stable, so unranked rows keep their relative order after ranked ones.
  const ordered = selected.toSorted((left, right) => rank(left) - rank(right));
  const next = [...sessions];
  slots.forEach((slot, index) => {
    next[slot] = ordered[index]!;
  });
  return next;
}

function rankBy(order: readonly string[]): (value: string | undefined) => number {
  const ranks = new Map(order.map((value, index) => [value, index]));
  return (value) => (value === undefined ? order.length : (ranks.get(value) ?? order.length));
}

/** Applies a reorder target to one host's rows, mirroring the provider's persisted order. */
export function reorderCatalogHostSessions(
  sessions: readonly SessionCatalogSession[],
  target: ReorderTarget,
): SessionCatalogSession[] {
  if (target.kind === "groups") {
    const rank = rankBy(target.order);
    return reorderSlots(
      sessions,
      (session) => customGroupOf(session) !== undefined,
      (session) => rank(customGroupOf(session)),
    );
  }
  const rank = rankBy(target.threadIds);
  return reorderSlots(
    sessions,
    (session) => customGroupOf(session) === target.group,
    (session) => rank(session.threadId),
  );
}

/** Returns catalogs with the reorder applied to the addressed catalog host. */
export function reorderSessionCatalogs(
  catalogs: readonly SessionCatalog[],
  params: Pick<SessionsCatalogReorderParams, "catalogId" | "hostId" | "target">,
): SessionCatalog[] {
  return catalogs.map((catalog) =>
    catalog.id !== params.catalogId
      ? catalog
      : {
          ...catalog,
          hosts: catalog.hosts.map((host) =>
            host.hostId !== params.hostId
              ? host
              : { ...host, sessions: reorderCatalogHostSessions(host.sessions, params.target) },
          ),
        },
  );
}

/** Moves `source` next to `target`; returns null when the order would not change. */
export function moveCatalogOrderEntry(
  order: readonly string[],
  source: string,
  target: string,
  position: "before" | "after",
): string[] | null {
  if (source === target || !order.includes(source) || !order.includes(target)) {
    return null;
  }
  const next = order.filter((entry) => entry !== source);
  next.splice(next.indexOf(target) + (position === "after" ? 1 : 0), 0, source);
  return next.every((entry, index) => entry === order[index]) ? null : next;
}
