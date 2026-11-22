/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { restorePropertyDescriptor } from "../test-helpers/property-descriptor.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import {
  loadStoredHiddenSessionCatalogFolderKeys,
  loadStoredHiddenSessionCatalogFolders,
  sessionCatalogFolderKey,
  setStoredSessionCatalogFolderHidden,
  SIDEBAR_HIDDEN_SESSION_CATALOG_FOLDERS_CHANGED_EVENT,
} from "./app-sidebar-session-types-fork.ts";
import {
  loadStoredCollapsedSessionSections,
  loadStoredHiddenSessionCatalogIds,
  loadStoredSidebarSessionSortMode,
  loadStoredSidebarSessionStatusFilter,
  loadStoredSidebarSessionOwnerFilter,
  loadStoredSidebarSessionsShowPreview,
  setStoredSessionCatalogHidden,
  storeSidebarSessionSortMode,
  storeSidebarSessionStatusFilter,
  storeSidebarSessionOwnerFilter,
  storeSidebarSessionsShowPreview,
} from "./app-sidebar-session-types.ts";

// getSafeLocalStorage only accepts an own value property under Vitest, so the
// jsdom getter-backed localStorage must be replaced with a plain mock.
let originalLocalStorage: PropertyDescriptor | undefined;
const gateway = "wss://one.example/ws";
const ownerFilter = (ownerId: string | null, involvingMe = false) => ({ ownerId, involvingMe });
const loadOwner = (user = "profile-ada", url = gateway) =>
  loadStoredSidebarSessionOwnerFilter(url, user);
const storeOwner = (ownerId: string | null, involvingMe = false, user = "profile-ada") =>
  storeSidebarSessionOwnerFilter(gateway, user, ownerFilter(ownerId, involvingMe));

beforeEach(() => {
  originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: createStorageMock(),
  });
});

afterEach(() => {
  restorePropertyDescriptor(globalThis, "localStorage", originalLocalStorage);
});

describe("sidebar session preferences", () => {
  it("defaults unknown stored values to active", () => {
    expect(loadStoredSidebarSessionStatusFilter()).toBe("active");
    localStorage.setItem("openclaw:sidebar:sessions:status-filter", "unexpected");
    expect(loadStoredSidebarSessionStatusFilter()).toBe("active");
  });

  it.each(["snoozed", "archived", "all"] as const)("stores the %s filter", (filter) => {
    storeSidebarSessionStatusFilter(filter);
    expect(loadStoredSidebarSessionStatusFilter()).toBe(filter);
  });

  it("defaults to all owners when no preference is stored", () => {
    // Chats created before participants were recorded have no owner, so a
    // "My sessions" default would hide them.
    expect(loadOwner()).toEqual(ownerFilter(null));
  });

  it("isolates owner and involving-me filters by gateway and authenticated user", () => {
    storeOwner("profile-bob");
    storeOwner(null, true, "profile-grace");
    expect(loadOwner()).toEqual(ownerFilter("profile-bob"));
    expect(loadOwner("profile-grace")).toEqual(ownerFilter(null, true));
    expect(loadOwner("profile-ada", "wss://two.example/ws")).toEqual(ownerFilter(null));
  });

  it("stores an explicit all-owner choice and rejects malformed stored values", () => {
    storeOwner("profile-bob");
    const key = localStorage.key(0);
    expect(key).not.toBeNull();
    localStorage.setItem(key ?? "", "owner:");
    expect(loadOwner()).toEqual(ownerFilter(null));
    storeOwner(null);
    expect(loadOwner()).toEqual(ownerFilter(null));
    expect(localStorage.getItem(key ?? "")).toBe("all");
  });

  it("keeps rendering when browser storage rejects access", () => {
    localStorage.getItem = () => {
      throw new Error("storage disabled");
    };
    localStorage.setItem = () => {
      throw new Error("storage disabled");
    };

    expect(loadOwner()).toEqual(ownerFilter(null));
    expect(() => storeOwner(null, true)).not.toThrow();
  });

  it.each([
    ["updated", undefined, "updated"],
    ["people", true, "people"],
    ["people", false, "created"],
  ] as const)("persists %s with people capability %s as %s", (mode, capability, expected) => {
    expect(storeSidebarSessionSortMode(mode, capability)).toBe(expected);
    expect(loadStoredSidebarSessionSortMode()).toBe(expected);
  });

  it("defaults Coding to compact while Online remains expanded", () => {
    expect([...loadStoredCollapsedSessionSections()]).toEqual(["work"]);
  });

  it("defaults to hiding previews and round-trips the stored choice", () => {
    expect(loadStoredSidebarSessionsShowPreview()).toBe(false);

    storeSidebarSessionsShowPreview(false);
    expect(loadStoredSidebarSessionsShowPreview()).toBe(false);

    storeSidebarSessionsShowPreview(true);
    expect(loadStoredSidebarSessionsShowPreview()).toBe(true);
  });

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
