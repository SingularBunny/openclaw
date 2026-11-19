import type { GatewaySessionRow } from "../api/types.ts";

/**
 * Fork: the Projects tree and the Pinned section read the same session from different copies (the
 * open agent's list, cached lists of other agents, the all-agent status window, the pin's own row).
 * Both take the copy the Gateway sampled last, so a pinned chat and its tree row show one status.
 * Sampling time is `snapshotAt`, advanced by `updatedAt` like the session row provenance merge.
 */
function sampledAt(row: GatewaySessionRow): number | undefined {
  return row.snapshotAt === undefined
    ? undefined
    : Math.max(row.snapshotAt, row.updatedAt ?? Number.NEGATIVE_INFINITY);
}

/** The offered copy only when it was sampled strictly later; otherwise the earlier-ranked one. */
export function newerSessionRow(
  current: GatewaySessionRow | undefined,
  offered: GatewaySessionRow | undefined,
): GatewaySessionRow | undefined {
  if (!current || !offered) {
    return current ?? offered;
  }
  const currentAt = sampledAt(current);
  const offeredAt = sampledAt(offered);
  return currentAt !== undefined && offeredAt !== undefined && offeredAt > currentAt
    ? offered
    : current;
}

/** One row per key in first-seen order, each the latest-sampled of its copies. */
export function freshestSessionRows(rows: readonly GatewaySessionRow[]): GatewaySessionRow[] {
  const byKey = new Map<string, GatewaySessionRow>();
  for (const row of rows) {
    byKey.set(row.key, newerSessionRow(byKey.get(row.key), row)!);
  }
  return [...byKey.values()];
}
