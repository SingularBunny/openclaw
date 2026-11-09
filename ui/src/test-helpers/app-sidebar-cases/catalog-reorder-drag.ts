import { describe, expect, it, vi } from "vitest";
import type {
  SessionCatalog,
  SessionCatalogSession,
} from "../../../../packages/gateway-protocol/src/index.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createGateway, createSessions, mountSidebar } from "../app-sidebar.ts";
import { createDataTransferStub } from "../drag-data.ts";
import { settleLitElement } from "../lit-settle.ts";
import { waitForFast } from "../wait-for.ts";
import "../../components/app-sidebar.tsx";

const CATALOG_REORDER_MIME = "application/x-openclaw-catalog-reorder";

function foldersCatalog(
  sessions: Array<
    Pick<SessionCatalogSession, "threadId" | "customGroup"> & Partial<SessionCatalogSession>
  >,
): SessionCatalog[] {
  return [
    {
      id: "projects",
      label: "Projects",
      capabilities: { continueSession: true, archive: false, reorder: true, move: true },
      hosts: [
        {
          hostId: "gateway:local",
          label: "Projects",
          kind: "gateway",
          connected: true,
          sessions: sessions.map((session) => ({
            status: "stored",
            archived: false,
            canContinue: true,
            canArchive: false,
            name: session.threadId,
            ...session,
          })),
        },
      ],
    },
  ];
}

function dispatchDragEvent(
  target: Element,
  type: "dragstart" | "dragover" | "drop" | "dragend",
  dataTransfer: ReturnType<typeof createDataTransferStub>,
) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, { dataTransfer: { value: dataTransfer }, clientY: { value: 0 } });
  target.dispatchEvent(event);
  return event;
}

async function mountFolders() {
  const request = vi.fn(async (method: string) =>
    method === "sessions.catalog.move"
      ? { ok: true }
      : method === "sessions.catalog.reorder"
        ? { ok: true }
        : {},
  );
  const gateway = createGateway({ request } as unknown as GatewayBrowserClient);
  const { sidebar } = await mountSidebar(
    gateway,
    createSessions("main", ["agent:main:main", "agent:main:a", "agent:main:b"]),
  );
  // Write access to session groups enables drags in the sidebar.
  sidebar.connected = true;
  sidebar.sessionData.sessionCatalogs = foldersCatalog([
    // Sessions of the open agent render as their live rows inside the folder.
    { threadId: "s:agent:main:a", sessionKey: "agent:main:a", customGroup: "Work" },
    // An ordinary Gateway session of the open agent (not an adopted native thread).
    {
      threadId: "s:agent:main:b",
      sessionKey: "agent:main:b",
      customGroup: "Work",
      source: "openclaw",
    },
    { threadId: "chat-h", customGroup: "Home" },
  ]);
  sidebar.sessionData.requestSessionDataUpdate();
  await settleLitElement(sidebar);
  const row = (key: string) => {
    // The session also has its ordinary row outside the catalog; take the one in the folder.
    const element = sidebar.querySelector(
      `.sidebar-session-catalog-project [data-session-key="${key}"]`,
    );
    if (!element) {
      throw new Error(`expected row ${key}`);
    }
    return element;
  };
  return { sidebar, request, row };
}

describe("AppSidebar catalog folder drag", () => {
  it("drags a live row inside its folder without starting a session-group drag", async () => {
    const { sidebar, request, row } = await mountFolders();
    const sectionsBefore = sidebar.querySelectorAll("[data-session-section]").length;
    const dataTransfer = createDataTransferStub();

    dispatchDragEvent(row("agent:main:a"), "dragstart", dataTransfer);
    await settleLitElement(sidebar);

    // An organizer drag would reveal empty session sections above the folders; in Chrome
    // that layout change during dragstart ends the drag before any dragover.
    expect(sidebar.sessionOrganizer.draggingSessionKey).toBeNull();
    expect(sidebar.querySelectorAll("[data-session-section]").length).toBe(sectionsBefore);
    expect(dataTransfer.types).toContain(CATALOG_REORDER_MIME);

    // Dropped on the lower half of b (jsdom rows have no height): after b.
    const over = dispatchDragEvent(row("agent:main:b"), "dragover", dataTransfer);
    expect(over.defaultPrevented).toBe(true);
    dispatchDragEvent(row("agent:main:b"), "drop", dataTransfer);

    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("sessions.catalog.reorder", {
        catalogId: "projects",
        hostId: "gateway:local",
        agentId: "main",
        target: {
          kind: "sessions",
          group: "Work",
          threadIds: ["s:agent:main:b", "s:agent:main:a"],
        },
      }),
    );
  });

  it("moves a row dropped on a row of another folder to that position", async () => {
    const { sidebar, request, row } = await mountFolders();
    const dataTransfer = createDataTransferStub();
    const target = sidebar.querySelector('[data-catalog-session-key*="chat-h"]')!;

    dispatchDragEvent(row("agent:main:b"), "dragstart", dataTransfer);
    expect(dispatchDragEvent(target, "dragover", dataTransfer).defaultPrevented).toBe(true);
    dispatchDragEvent(target, "drop", dataTransfer);
    await settleLitElement(sidebar);

    expect(request).toHaveBeenCalledWith("sessions.catalog.move", {
      catalogId: "projects",
      hostId: "gateway:local",
      agentId: "main",
      threadId: "s:agent:main:b",
      group: "Home",
      threadIds: ["chat-h", "s:agent:main:b"],
    });
    // Shown in the target folder at once.
    const moved = sidebar.sessionData.sessionCatalogs[0]!.hosts[0]!.sessions.find(
      (session) => session.threadId === "s:agent:main:b",
    );
    expect(moved?.customGroup).toBe("Home");
  });

  it("moves a row dropped on another folder's header into that folder", async () => {
    const { request, row, sidebar } = await mountFolders();
    const dataTransfer = createDataTransferStub();
    const home = sidebar.querySelector('[data-session-catalog-project="custom:Home"]')!;

    dispatchDragEvent(row("agent:main:a"), "dragstart", dataTransfer);
    expect(dispatchDragEvent(home, "dragover", dataTransfer).defaultPrevented).toBe(true);
    dispatchDragEvent(home, "drop", dataTransfer);

    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("sessions.catalog.move", {
        catalogId: "projects",
        hostId: "gateway:local",
        agentId: "main",
        threadId: "s:agent:main:a",
        group: "Home",
      }),
    );
    // The own folder's header is not a move target.
    const work = sidebar.querySelector('[data-session-catalog-project="custom:Work"]')!;
    dispatchDragEvent(row("agent:main:a"), "dragstart", dataTransfer);
    expect(dispatchDragEvent(work, "dragover", dataTransfer).defaultPrevented).toBe(false);
  });
});

describe("AppSidebar catalog rows that are Gateway sessions", () => {
  it("keep the regular session menu; adopted native rows keep the catalog menu", async () => {
    const { sidebar, row } = await mountFolders();
    const openMenu = (key: string) =>
      row(key).dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 1, clientY: 1 }),
      );

    openMenu("agent:main:a");
    await settleLitElement(sidebar);
    expect(sidebar.sidebarMenus.catalogMenu.isOpen).toBe(true);
    sidebar.sidebarMenus.catalogMenu.close();
    await settleLitElement(sidebar);

    openMenu("agent:main:b");
    await settleLitElement(sidebar);
    expect(sidebar.sidebarMenus.catalogMenu.isOpen).toBe(false);
  });
});
