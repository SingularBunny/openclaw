import { describe, expect, it, vi } from "vitest";
import type {
  AgentsListResult,
  SessionsCatalogListResult,
} from "../../../../packages/gateway-protocol/src/index.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import { createGatewayHarness, createSessions, mountSidebar } from "../app-sidebar.ts";
import { settleLitElement } from "../lit-settle.ts";
import "../../components/app-sidebar.tsx";

const catalog: SessionsCatalogListResult = {
  catalogs: [
    {
      id: "claude",
      label: "Claude",
      capabilities: { continueSession: true, archive: true },
      hosts: [
        {
          hostId: "gateway:local",
          label: "Local",
          kind: "gateway",
          connected: true,
          sessions: [
            {
              threadId: "thread-shop",
              name: "Shop work",
              cwd: "/work/shop",
              status: "idle",
              archived: false,
              canContinue: true,
              canArchive: true,
              sessionKey: "agent:shop:catalog-1",
            },
            {
              threadId: "thread-docs",
              name: "Docs work",
              cwd: "/work/docs",
              status: "idle",
              archived: false,
              canContinue: true,
              canArchive: true,
            },
          ],
        },
      ],
    },
  ],
};

async function mountFolders() {
  vi.useFakeTimers();
  const request = vi.fn().mockResolvedValue(catalog);
  const gateway = createGatewayHarness({ request } as unknown as GatewayBrowserClient);
  gateway.publish({
    hello: {
      auth: { role: "operator", scopes: ["operator.admin"] },
      features: { methods: ["sessions.catalog.list", "sessions.create"] },
    } as ApplicationGatewaySnapshot["hello"],
  });
  const agentsList = {
    defaultId: "main",
    mainKey: "main",
    scope: "per-sender",
    agents: [{ id: "main" }, { id: "shop" }],
  } as AgentsListResult;
  const { sidebar } = await mountSidebar(
    gateway.gateway,
    createSessions("main", ["agent:main:main"]),
    "panel",
    agentsList,
  );
  const onOpenNewSession = vi.fn();
  sidebar.onOpenNewSession = onOpenNewSession;
  sidebar.connected = true;
  await sidebar.updateComplete;
  await vi.advanceTimersByTimeAsync(0);
  vi.advanceTimersToNextFrame();
  await settleLitElement(sidebar);
  return { sidebar, onOpenNewSession };
}

const head = (sidebar: HTMLElement, folderId: string) => {
  const element = sidebar.querySelector<HTMLElement>(
    `[data-session-section="catalog:claude"] [data-session-catalog-project="${folderId}"]`,
  );
  if (!element) {
    throw new Error(`expected catalog folder ${folderId}`);
  }
  return element;
};

const menuValues = (sidebar: HTMLElement) =>
  [...sidebar.querySelectorAll<HTMLElement>(".sidebar-catalog-folder-menu [data-value]")].map(
    (item) => item.dataset.value,
  );

describe("AppSidebar catalog folder menu", () => {
  it("opens from the keyboard and starts a new chat with the folder's agent", async () => {
    try {
      const { sidebar, onOpenNewSession } = await mountFolders();
      const shop = head(sidebar, "project:/work/shop");
      shop.focus();
      const key = new KeyboardEvent("keydown", {
        key: "F10",
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      });
      shop.dispatchEvent(key);
      await sidebar.updateComplete;
      expect(key.defaultPrevented).toBe(true);
      expect(menuValues(sidebar)).toEqual([
        "new-chat",
        "copy-path",
        "agent-settings",
        "toggle",
        "hide-catalog-folder",
      ]);
      sidebar
        .querySelector<HTMLElement>('.sidebar-catalog-folder-menu [data-value="new-chat"]')
        ?.click();
      await sidebar.updateComplete;
      expect(onOpenNewSession).toHaveBeenCalledExactlyOnceWith("shop");
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows + only for folders with a known agent and ⋯ on every folder", async () => {
    try {
      const { sidebar, onOpenNewSession } = await mountFolders();
      const row = (folderId: string) =>
        head(sidebar, folderId).closest(".sidebar-session-catalog-project__row")!;
      const plus = row("project:/work/shop").querySelector<HTMLAnchorElement>(
        "a.sidebar-session-catalog-project__action",
      );
      expect(plus?.getAttribute("href")).toContain("/new?agent=shop");
      expect(row("project:/work/docs").querySelector("a")).toBeNull();
      plus?.click();
      expect(onOpenNewSession).toHaveBeenCalledExactlyOnceWith("shop");

      row("project:/work/docs")
        .querySelector<HTMLButtonElement>("[data-session-catalog-folder-menu]")
        ?.click();
      await sidebar.updateComplete;
      const newChat = sidebar.querySelector<HTMLElement>(
        '.sidebar-catalog-folder-menu [data-value="new-chat"]',
      );
      expect(newChat?.hasAttribute("disabled")).toBe(true);
      expect(menuValues(sidebar)).not.toContain("agent-settings");
    } finally {
      vi.useRealTimers();
    }
  });
});
