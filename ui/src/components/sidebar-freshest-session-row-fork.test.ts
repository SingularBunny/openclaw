import { expect, it } from "vitest";
import type { GatewaySessionRow } from "../api/types.ts";
import { freshestSessionRows, newerSessionRow } from "./sidebar-freshest-session-row-fork.ts";

const row = (key: string, snapshotAt?: number, extra: Partial<GatewaySessionRow> = {}) =>
  ({ key, kind: "direct", updatedAt: null, snapshotAt, ...extra }) as GatewaySessionRow;

it("keeps the earlier-ranked copy unless a later one was sampled after it", () => {
  const cached = row("agent:a:x", 100, { hasActiveRun: true });
  const status = row("agent:a:x", 200, { hasActiveRun: false });
  expect(newerSessionRow(cached, status)).toBe(status);
  expect(newerSessionRow(status, cached)).toBe(status);
  expect(newerSessionRow(row("agent:a:x", 100), row("agent:a:x", 100))?.snapshotAt).toBe(100);
  const unsampled = row("agent:a:x");
  expect(newerSessionRow(unsampled, status)).toBe(unsampled);
  expect(newerSessionRow(undefined, status)).toBe(status);
});

it("dedupes a session list by key in first-seen order, each the latest-sampled copy", () => {
  const current = row("agent:a:one", 300);
  const staleCache = row("agent:b:two", 100, { unread: true });
  const freshStatus = row("agent:b:two", 250, { unread: false });
  const rows = freshestSessionRows([current, staleCache, row("agent:a:one", 50), freshStatus]);
  expect(rows).toEqual([current, freshStatus]);
});

it("counts a later write on a copy as fresher sampling", () => {
  const sampled = row("agent:a:x", 100, { updatedAt: 400 });
  expect(newerSessionRow(row("agent:a:x", 300), sampled)).toBe(sampled);
});
