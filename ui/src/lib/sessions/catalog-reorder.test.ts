import { describe, expect, it } from "vitest";
import type {
  SessionCatalog,
  SessionCatalogSession,
} from "../../../../packages/gateway-protocol/src/index.ts";
import { groupCatalogSessionsByProject } from "./catalog-project-grouping.ts";
import {
  insertCatalogOrderEntry,
  moveCatalogHostSession,
  moveCatalogOrderEntry,
  reorderCatalogHostSessions,
  reorderSessionCatalogs,
} from "./catalog-reorder.ts";

function session(threadId: string, customGroup?: string): SessionCatalogSession {
  return {
    threadId,
    status: "stored",
    archived: false,
    canContinue: false,
    canArchive: false,
    ...(customGroup ? { customGroup } : {}),
  };
}

const threadIds = (sessions: readonly SessionCatalogSession[]) =>
  sessions.map((entry) => entry.threadId);

describe("reorderCatalogHostSessions", () => {
  const sessions = [
    session("a1", "Alpha"),
    session("loose"),
    session("b1", "Beta"),
    session("a2", "Alpha"),
    session("g1", "Gamma"),
    session("b2", " Beta "),
  ];

  it("moves folders into the new order and keeps rows without a folder in place", () => {
    const next = reorderCatalogHostSessions(sessions, {
      kind: "groups",
      order: ["Gamma", "Beta", "Alpha"],
    });

    expect(threadIds(next)).toEqual(["g1", "loose", "b1", "b2", "a1", "a2"]);
    expect(groupCatalogSessionsByProject(next).groups.map((group) => group.label)).toEqual([
      "Gamma",
      "Beta",
      "Alpha",
    ]);
  });

  it("puts folders missing from the order after the listed ones", () => {
    const next = reorderCatalogHostSessions(sessions, { kind: "groups", order: ["Beta"] });

    expect(threadIds(next)).toEqual(["b1", "loose", "b2", "a1", "a2", "g1"]);
  });

  it("reorders only the rows of the addressed folder", () => {
    const next = reorderCatalogHostSessions(sessions, {
      kind: "sessions",
      group: "Alpha",
      threadIds: ["a2", "a1"],
    });

    expect(threadIds(next)).toEqual(["a2", "loose", "b1", "a1", "g1", "b2"]);
  });
});

describe("reorderSessionCatalogs", () => {
  it("touches only the addressed catalog host", () => {
    const host = (hostId: string) => ({
      hostId,
      label: hostId,
      kind: "gateway" as const,
      connected: true,
      sessions: [session("one", "Alpha"), session("two", "Beta")],
    });
    const catalogs: SessionCatalog[] = [
      {
        id: "claude",
        label: "Claude",
        capabilities: { continueSession: false, archive: false, reorder: true },
        hosts: [host("gateway:local"), host("node:mac")],
      },
    ];

    const next = reorderSessionCatalogs(catalogs, {
      catalogId: "claude",
      hostId: "node:mac",
      target: { kind: "groups", order: ["Beta", "Alpha"] },
    });

    expect(next[0]!.hosts[0]).toBe(catalogs[0]!.hosts[0]);
    expect(threadIds(next[0]!.hosts[1]!.sessions)).toEqual(["two", "one"]);
    expect(threadIds(catalogs[0]!.hosts[1]!.sessions)).toEqual(["one", "two"]);
  });
});

describe("moveCatalogOrderEntry", () => {
  it("moves an entry before or after its drop target", () => {
    expect(moveCatalogOrderEntry(["a", "b", "c"], "c", "a", "before")).toEqual(["c", "a", "b"]);
    expect(moveCatalogOrderEntry(["a", "b", "c"], "a", "b", "after")).toEqual(["b", "a", "c"]);
  });

  it("returns null when nothing would change", () => {
    expect(moveCatalogOrderEntry(["a", "b"], "a", "a", "after")).toBeNull();
    expect(moveCatalogOrderEntry(["a", "b"], "a", "b", "before")).toBeNull();
    expect(moveCatalogOrderEntry(["a", "b"], "x", "b", "before")).toBeNull();
  });
});

describe("moveCatalogHostSession", () => {
  const row = (threadId: string, customGroup: string): SessionCatalogSession => ({
    threadId,
    customGroup,
    status: "stored",
    archived: false,
    canContinue: false,
    canArchive: false,
  });
  const rows = [row("a1", "Alpha"), row("a2", "Alpha"), row("b1", "Beta"), row("b2", "Beta")];
  const view = (sessions: SessionCatalogSession[]) =>
    sessions.map((entry) => `${entry.customGroup}:${entry.threadId}`);

  it("puts the row where the target order places it", () => {
    expect(
      view(
        moveCatalogHostSession(rows, {
          threadId: "a1",
          group: "Beta",
          threadIds: ["b1", "a1", "b2"],
        }),
      ),
    ).toEqual(["Alpha:a2", "Beta:b1", "Beta:a1", "Beta:b2"]);
  });

  it("appends the row to the folder without a position, or to the end for a new folder", () => {
    expect(view(moveCatalogHostSession(rows, { threadId: "a1", group: "Beta" }))).toEqual([
      "Alpha:a2",
      "Beta:b1",
      "Beta:b2",
      "Beta:a1",
    ]);
    expect(view(moveCatalogHostSession(rows, { threadId: "b1", group: "Gamma" }))).toEqual([
      "Alpha:a1",
      "Alpha:a2",
      "Beta:b2",
      "Gamma:b1",
    ]);
    expect(moveCatalogHostSession(rows, { threadId: "x", group: "Beta" })).toEqual(rows);
  });
});

describe("insertCatalogOrderEntry", () => {
  it("inserts a row from another folder next to its drop target", () => {
    expect(insertCatalogOrderEntry(["a", "b"], "x", "a", "after")).toEqual(["a", "x", "b"]);
    expect(insertCatalogOrderEntry(["a", "b"], "x", "a", "before")).toEqual(["x", "a", "b"]);
    expect(insertCatalogOrderEntry(["a", "b"], "x", "y", "before")).toBeNull();
  });
});
