import { describe, expect, it, vi } from "vitest";
import {
  catalogFolderMenuContext,
  catalogFolderMenuEntries,
  catalogFolderRevealPath,
  isContextMenuKeyEvent,
  resolveCatalogFolderAgent,
  resolveCatalogFolderNewChat,
  resolveCatalogFolderTargets,
  type CatalogFolderMenuContext,
} from "./sidebar-catalog-folder-actions.ts";
import { openCatalogFolderNewChat } from "./sidebar-catalog-folder-run.ts";

const context = (
  overrides: Partial<Parameters<typeof catalogFolderMenuContext>[0]> = {},
): CatalogFolderMenuContext =>
  catalogFolderMenuContext({
    kind: "project",
    title: "/work/shop",
    sessions: [],
    fallbackAgentId: "main",
    collapsed: false,
    onToggle: () => {},
    ...overrides,
  });

describe("catalog folder agent", () => {
  it("ranks the agents of opened chats, most frequent first", () => {
    const folder = context({
      sessions: [
        { sessionKey: "agent:main:a" },
        {},
        { sessionKey: "agent:shop:b" },
        { sessionKey: "agent:shop:c" },
      ],
    });
    expect(folder.sessionAgentIds).toEqual(["shop", "main"]);
    expect(folder.sessionKeysByAgent).toEqual({ main: "agent:main:a", shop: "agent:shop:b" });
    expect(resolveCatalogFolderAgent(folder, null)).toBe("shop");
  });

  it("skips agents the agent list no longer has", () => {
    const folder = context({ sessions: [{ sessionKey: "agent:gone:a" }] });
    expect(resolveCatalogFolderAgent(folder, [{ id: "main" }])).toBeNull();
    expect(resolveCatalogFolderAgent(folder, null)).toBe("gone");
  });

  it("falls back to the agent whose workspace is the project folder", () => {
    const agents = [
      { id: "main", workspace: "/work" },
      { id: "Shop", workspace: "/work/shop/" },
    ];
    expect(resolveCatalogFolderAgent(context(), agents)).toBe("shop");
    expect(resolveCatalogFolderAgent(context({ kind: "custom" }), agents)).toBeNull();
    expect(resolveCatalogFolderAgent(context({ title: "/elsewhere" }), agents)).toBeNull();
  });
});

describe("catalog folder new chat", () => {
  it("opens a project folder's chat with its agent", () => {
    expect(resolveCatalogFolderNewChat(context(), "shop", "shop", [])).toEqual({
      agentId: "shop",
    });
    expect(resolveCatalogFolderNewChat(context(), "shop", null, [])).toBeNull();
  });

  it("targets the session group a custom folder is named after", () => {
    const custom = context({ kind: "custom", title: "Custom group: Release" });
    expect(resolveCatalogFolderNewChat(custom, "Release", null, ["Release"])).toEqual({
      agentId: "main",
      target: { group: "Release" },
    });
    expect(resolveCatalogFolderNewChat(custom, "Release", "shop", ["Release"])).toEqual({
      agentId: "shop",
      target: { group: "Release" },
    });
    expect(resolveCatalogFolderNewChat(custom, "Release", "shop", [])).toEqual({
      agentId: "shop",
    });
    expect(resolveCatalogFolderNewChat(custom, "Release", null, [])).toBeNull();
  });

  it("offers no new chat in a person folder", () => {
    expect(resolveCatalogFolderNewChat(context({ kind: "person" }), "Ann", "main", [])).toBeNull();
  });

  it("resolves from the live agent list and session groups", () => {
    const app = {
      agents: { state: { agentsList: { agents: [{ id: "main" }, { id: "shop" }] } } },
      sessions: { state: { groupSettings: [{ name: "Release" }] } },
    } as unknown as Parameters<typeof resolveCatalogFolderTargets>[0];
    const folder = context({ sessions: [{ sessionKey: "agent:shop:a" }] });
    expect(resolveCatalogFolderTargets(app, folder, "shop")).toEqual({
      agentId: "shop",
      newChat: { agentId: "shop" },
    });
  });

  it("calls openNewSession with the agent and, for a group, the target", () => {
    const open = vi.fn();
    expect(openCatalogFolderNewChat({ agentId: "shop" }, open)).toBe(true);
    expect(open).toHaveBeenLastCalledWith("shop");
    expect(open.mock.lastCall).toHaveLength(1);
    openCatalogFolderNewChat({ agentId: "main", target: { group: "Release" } }, open);
    expect(open).toHaveBeenLastCalledWith("main", { group: "Release" });
    expect(openCatalogFolderNewChat(null, open)).toBe(false);
    expect(open).toHaveBeenCalledTimes(2);
  });
});

describe("catalog folder menu entries", () => {
  const entries = (
    kind: CatalogFolderMenuContext["kind"],
    options: Partial<Parameters<typeof catalogFolderMenuEntries>[0]> = {},
  ) =>
    catalogFolderMenuEntries({
      context: { kind, path: kind === "project" ? "/work/shop" : null },
      newChat: { agentId: "shop" },
      noAgentReason: "no agent",
      agentId: "shop",
      reveal: { available: true },
      ...options,
    });

  it("lists create, locate, configure and view items for a project folder", () => {
    expect(entries("project").map((entry) => entry.action)).toEqual([
      "new-chat",
      "reveal",
      "copy-path",
      "agent-settings",
      "toggle",
      "hide-catalog-folder",
    ]);
  });

  it("has no path items for custom folders and no new chat for person folders", () => {
    expect(entries("custom").map((entry) => entry.action)).toEqual([
      "new-chat",
      "agent-settings",
      "toggle",
      "hide-catalog-folder",
    ]);
    expect(entries("person", { agentId: null }).map((entry) => entry.action)).toEqual([
      "toggle",
      "hide-catalog-folder",
    ]);
  });

  it("keeps New chat visible but disabled with the reason", () => {
    expect(entries("project", { newChat: null })[0]).toEqual({
      action: "new-chat",
      disabledReason: "no agent",
    });
    expect(entries("project", { newChatDisabledReason: "offline" })[0]?.disabledReason).toBe(
      "offline",
    );
  });

  it("drops reveal without admin access and passes its pending reason", () => {
    expect(
      entries("project", { reveal: { available: false } }).some(
        (entry) => entry.action === "reveal",
      ),
    ).toBe(false);
    expect(
      entries("project", { reveal: { available: true, disabledReason: "checking" } })[1],
    ).toEqual({ action: "reveal", disabledReason: "checking" });
  });
});

describe("catalog folder keyboard and reveal", () => {
  it("opens on the Menu key and Shift+F10 only", () => {
    const press = (key: string, mods: Partial<KeyboardEvent> = {}) =>
      isContextMenuKeyEvent({
        key,
        shiftKey: false,
        altKey: false,
        ctrlKey: false,
        metaKey: false,
        ...mods,
      });
    expect(press("ContextMenu")).toBe(true);
    expect(press("F10", { shiftKey: true })).toBe(true);
    expect(press("F10")).toBe(false);
    expect(press("F10", { shiftKey: true, ctrlKey: true })).toBe(false);
    expect(press("Enter")).toBe(false);
  });

  it("opens only folders inside the chat workspace", () => {
    expect(catalogFolderRevealPath("/work/shop", "/work/shop/")).toBe("");
    expect(catalogFolderRevealPath("/work", "/work/shop")).toBe("shop");
    expect(catalogFolderRevealPath("/work/shop", "/work/shopping")).toBeNull();
    expect(catalogFolderRevealPath("/agents/shop", "/work/shop")).toBeNull();
    expect(catalogFolderRevealPath(undefined, "/work/shop")).toBeNull();
  });
});
