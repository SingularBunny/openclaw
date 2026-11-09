import type {
  SessionCatalog,
  SessionCatalogSession,
  SessionsCatalogMoveParams,
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

/**
 * Moves one row of a host into another custom folder, mirroring the provider's
 * move: the row takes the folder name and sits where `threadIds` places it, or
 * after the folder's last row when the drop had no position.
 */
export function moveCatalogHostSession(
  sessions: readonly SessionCatalogSession[],
  params: Pick<SessionsCatalogMoveParams, "threadId" | "group" | "threadIds">,
): SessionCatalogSession[] {
  const moved = sessions.find((session) => session.threadId === params.threadId);
  if (!moved) {
    return [...sessions];
  }
  const rest = sessions.filter((session) => session !== moved);
  const row = { ...moved, customGroup: params.group };
  const order = params.threadIds ?? [];
  const following = order.slice(order.indexOf(params.threadId) + 1);
  const ownIndex = order.indexOf(params.threadId);
  let index = -1;
  if (ownIndex >= 0) {
    // Before the first row that follows the moved one in the requested order.
    for (const threadId of following) {
      index = rest.findIndex(
        (session) => session.threadId === threadId && customGroupOf(session) === params.group,
      );
      if (index >= 0) {
        break;
      }
    }
  }
  if (index < 0) {
    const last = rest.findLastIndex((session) => customGroupOf(session) === params.group);
    index = last >= 0 ? last + 1 : rest.length;
  }
  return [...rest.slice(0, index), row, ...rest.slice(index)];
}

/** Returns catalogs with the move applied to the addressed catalog host. */
export function moveSessionCatalogs(
  catalogs: readonly SessionCatalog[],
  params: Pick<
    SessionsCatalogMoveParams,
    "catalogId" | "hostId" | "threadId" | "group" | "threadIds"
  >,
): SessionCatalog[] {
  return catalogs.map((catalog) =>
    catalog.id !== params.catalogId
      ? catalog
      : {
          ...catalog,
          hosts: catalog.hosts.map((host) =>
            host.hostId !== params.hostId
              ? host
              : { ...host, sessions: moveCatalogHostSession(host.sessions, params) },
          ),
        },
  );
}

/** Puts `source`, a row from another folder, next to `target`; null when `target` is unknown. */
export function insertCatalogOrderEntry(
  order: readonly string[],
  source: string,
  target: string,
  position: "before" | "after",
): string[] | null {
  const next = order.filter((entry) => entry !== source);
  const index = next.indexOf(target);
  if (index < 0) {
    return null;
  }
  next.splice(index + (position === "after" ? 1 : 0), 0, source);
  return next;
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
