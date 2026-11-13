/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../test-helpers/storage.ts";
import {
  loadStoredCollapsedSessionSections,
  loadStoredHiddenSessionCatalogFolderKeys,
  loadStoredHiddenSessionCatalogFolders,
  loadStoredHiddenSessionCatalogIds,
  loadStoredSidebarSessionSortMode,
  loadStoredSidebarSessionStatusFilter,
  loadStoredSidebarSessionOwnerFilter,
  loadStoredSidebarSessionsShowPreview,
  sessionCatalogFolderKey,
  setStoredSessionCatalogFolderHidden,
  setStoredSessionCatalogHidden,
  SIDEBAR_HIDDEN_SESSION_CATALOG_FOLDERS_CHANGED_EVENT,
  storeSidebarSessionSortMode,
  storeSidebarSessionStatusFilter,
  storeSidebarSessionOwnerFilter,
  storeSidebarSessionsShowPreview,
} from "./app-sidebar-session-types.ts";

// getSafeLocalStorage only accepts an own value property under Vitest, so the
// jsdom getter-backed localStorage must be replaced with a plain mock.
let originalLocalStorage: PropertyDescriptor | undefined;

beforeEach(() => {
  originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: createStorageMock(),
  });
});

afterEach(() => {
  if (originalLocalStorage) {
    Object.defineProperty(globalThis, "localStorage", originalLocalStorage);
  } else {
    Reflect.deleteProperty(globalThis, "localStorage");
  }
});

describe("sidebar session status preference", () => {
  it("defaults unknown stored values to active", () => {
    expect(loadStoredSidebarSessionStatusFilter()).toBe("active");
    localStorage.setItem("openclaw:sidebar:sessions:status-filter", "unexpected");
    expect(loadStoredSidebarSessionStatusFilter()).toBe("active");
  });

  it("stores snoozed, archived, and all filters", () => {
    storeSidebarSessionStatusFilter("snoozed");
    expect(loadStoredSidebarSessionStatusFilter()).toBe("snoozed");
    storeSidebarSessionStatusFilter("archived");
    expect(loadStoredSidebarSessionStatusFilter()).toBe("archived");
    storeSidebarSessionStatusFilter("all");
    expect(loadStoredSidebarSessionStatusFilter()).toBe("all");
  });
});

describe("sidebar session owner preference", () => {
  it("isolates owner and involving-me filters by gateway and authenticated user", () => {
    storeSidebarSessionOwnerFilter("wss://one.example/ws", "profile-ada", {
      ownerId: "profile-bob",
      involvingMe: false,
    });
    storeSidebarSessionOwnerFilter("wss://one.example/ws", "profile-grace", {
      ownerId: null,
      involvingMe: true,
    });

    expect(loadStoredSidebarSessionOwnerFilter("wss://one.example/ws", "profile-ada")).toEqual({
      ownerId: "profile-bob",
      involvingMe: false,
    });
    expect(loadStoredSidebarSessionOwnerFilter("wss://one.example/ws", "profile-grace")).toEqual({
      ownerId: null,
      involvingMe: true,
    });
    expect(loadStoredSidebarSessionOwnerFilter("wss://two.example/ws", "profile-ada")).toEqual({
      ownerId: "profile-ada",
      involvingMe: false,
    });
  });

  it("stores an explicit all-owner choice and rejects malformed stored values", () => {
    storeSidebarSessionOwnerFilter("wss://one.example/ws", "profile-ada", {
      ownerId: "profile-bob",
      involvingMe: false,
    });
    const key = localStorage.key(0);
    expect(key).not.toBeNull();
    localStorage.setItem(key ?? "", "owner:");
    expect(loadStoredSidebarSessionOwnerFilter("wss://one.example/ws", "profile-ada")).toEqual({
      ownerId: null,
      involvingMe: false,
    });

    storeSidebarSessionOwnerFilter("wss://one.example/ws", "profile-ada", {
      ownerId: null,
      involvingMe: false,
    });
    expect(loadStoredSidebarSessionOwnerFilter("wss://one.example/ws", "profile-ada")).toEqual({
      ownerId: null,
      involvingMe: false,
    });
    expect(localStorage.getItem(key ?? "")).toBe("all");
  });

  it("keeps rendering when browser storage rejects access", () => {
    localStorage.getItem = () => {
      throw new Error("storage disabled");
    };
    localStorage.setItem = () => {
      throw new Error("storage disabled");
    };

    expect(loadStoredSidebarSessionOwnerFilter("wss://one.example/ws", "profile-ada")).toEqual({
      ownerId: "profile-ada",
      involvingMe: false,
    });
    expect(() =>
      storeSidebarSessionOwnerFilter("wss://one.example/ws", "profile-ada", {
        ownerId: null,
        involvingMe: true,
      }),
    ).not.toThrow();
  });
});

describe("sidebar session sort preference", () => {
  it("round-trips updated and people modes", () => {
    expect(storeSidebarSessionSortMode("updated", undefined)).toBe("updated");
    expect(loadStoredSidebarSessionSortMode()).toBe("updated");
    expect(storeSidebarSessionSortMode("people", true)).toBe("people");
    expect(loadStoredSidebarSessionSortMode()).toBe("people");
  });

  it("stores created instead of a people sort the gateway denied", () => {
    expect(storeSidebarSessionSortMode("people", false)).toBe("created");
    expect(loadStoredSidebarSessionSortMode()).toBe("created");
  });
});

describe("collapsed sidebar sections preference", () => {
  it("defaults Coding to compact while Online remains expanded", () => {
    expect([...loadStoredCollapsedSessionSections()]).toEqual(["work"]);
  });
});

describe("sidebar session preview preference", () => {
  it("defaults to hiding previews and round-trips the stored choice", () => {
    expect(loadStoredSidebarSessionsShowPreview()).toBe(false);

    storeSidebarSessionsShowPreview(false);
    expect(loadStoredSidebarSessionsShowPreview()).toBe(false);

    storeSidebarSessionsShowPreview(true);
    expect(loadStoredSidebarSessionsShowPreview()).toBe(true);
  });
});

describe("hidden session catalog preference", () => {
  it("round-trips catalog ids and reverses one hide at a time", () => {
    setStoredSessionCatalogHidden("codex", true);
    setStoredSessionCatalogHidden("claude", true);
    expect([...loadStoredHiddenSessionCatalogIds()]).toEqual(["codex", "claude"]);

    setStoredSessionCatalogHidden("codex", false);
    expect([...loadStoredHiddenSessionCatalogIds()]).toEqual(["claude"]);
  });

  it.each(["not-json", JSON.stringify({ catalog: "codex" })])(
    "treats malformed storage as empty: %s",
    (stored) => {
      localStorage.setItem("openclaw:sidebar:sessions:hidden-catalogs", stored);
      expect(loadStoredHiddenSessionCatalogIds().size).toBe(0);
    },
  );
});

describe("hidden session catalog folder preference", () => {
  const storageKey = "openclaw:sidebar:sessions:hidden-catalog-folders";
  const appFolder = {
    catalogId: "claude",
    folderId: "project:/work/app",
    catalogLabel: "Claude Code",
    label: "app",
  };
  const docsFolder = {
    catalogId: "projects",
    folderId: "custom:Docs",
    catalogLabel: "Projects",
    label: "Docs",
  };

  it("round-trips folders with labels, keyed by catalog and folder, and announces each change", () => {
    const changed = vi.fn();
    window.addEventListener(SIDEBAR_HIDDEN_SESSION_CATALOG_FOLDERS_CHANGED_EVENT, changed);
    try {
      setStoredSessionCatalogFolderHidden(appFolder, true);
      setStoredSessionCatalogFolderHidden(docsFolder, true);
      // Hiding the same folder again replaces it instead of listing it twice.
      setStoredSessionCatalogFolderHidden({ ...appFolder, label: "app (renamed)" }, true);
      expect(loadStoredHiddenSessionCatalogFolders()).toEqual([
        docsFolder,
        { ...appFolder, label: "app (renamed)" },
      ]);
      expect([...loadStoredHiddenSessionCatalogFolderKeys()].toSorted()).toEqual(
        [
          sessionCatalogFolderKey("claude", "project:/work/app"),
          sessionCatalogFolderKey("projects", "custom:Docs"),
        ].toSorted(),
      );

      setStoredSessionCatalogFolderHidden(appFolder, false);
      expect(loadStoredHiddenSessionCatalogFolders()).toEqual([docsFolder]);
      expect(changed).toHaveBeenCalledTimes(4);
    } finally {
      window.removeEventListener(SIDEBAR_HIDDEN_SESSION_CATALOG_FOLDERS_CHANGED_EVENT, changed);
    }
  });

  it("does not mix a folder id with the same id in another catalog", () => {
    setStoredSessionCatalogFolderHidden(appFolder, true);
    const keys = loadStoredHiddenSessionCatalogFolderKeys();
    expect(keys.has(sessionCatalogFolderKey("claude", "project:/work/app"))).toBe(true);
    expect(keys.has(sessionCatalogFolderKey("codex", "project:/work/app"))).toBe(false);
    // Hidden folders never hide the whole section.
    expect(loadStoredHiddenSessionCatalogIds().size).toBe(0);
  });

  it("falls back to ids for missing labels and drops entries without ids", () => {
    localStorage.setItem(
      storageKey,
      JSON.stringify([
        { catalogId: "claude", folderId: "project:/x" },
        { catalogId: "claude" },
        "claude\u0000project:/y",
        null,
      ]),
    );
    expect(loadStoredHiddenSessionCatalogFolders()).toEqual([
      { catalogId: "claude", folderId: "project:/x", catalogLabel: "claude", label: "project:/x" },
    ]);
  });

  it.each(["not-json", JSON.stringify({ catalogId: "claude" })])(
    "treats malformed storage as empty: %s",
    (stored) => {
      localStorage.setItem(storageKey, stored);
      expect(loadStoredHiddenSessionCatalogFolders()).toEqual([]);
    },
  );
});
