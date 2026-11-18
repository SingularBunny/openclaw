import { describe, expect, it } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createGateway, createSessions, mountSidebar } from "../app-sidebar.ts";
import { settleLitElement } from "../lit-settle.ts";
import "../../components/app-sidebar.tsx";

describe("AppSidebar catalog session visibility", () => {
  const mountCatalog = async (grouping: "project" | "none", sessionCount = 7) => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(gateway, createSessions("main", ["agent:main:main"]));
    (
      sidebar as typeof sidebar & {
        catalogProjectGrouping: "project" | "none";
      }
    ).catalogProjectGrouping = grouping;
    sidebar.sessionData.sessionCatalogs = [
      {
        id: "codex",
        label: "Codex",
        capabilities: { continueSession: true, archive: false },
        hosts: [
          {
            hostId: "gateway:local",
            label: "Local Codex",
            kind: "gateway",
            connected: true,
            sessions: Array.from({ length: sessionCount }, (_, index) => ({
              threadId: `thread-${index + 1}`,
              name: `Session ${index + 1}`,
              cwd: "/workspace/openclaw",
              status: "stored" as const,
              archived: false,
              canContinue: true,
              canArchive: false,
            })),
          },
        ],
      },
    ];
    sidebar.sessionData.requestSessionDataUpdate();
    await settleLitElement(sidebar);
    return sidebar;
  };

  const verifyExpansion = async (
    container: HTMLElement,
    sidebar: HTMLElement & { updateComplete: Promise<boolean> },
  ) => {
    const rows = () => container.querySelectorAll("[data-session-key]").length;
    const pagingButton = () =>
      container.querySelector<HTMLButtonElement>(".sidebar-session-pagination__button");

    expect(rows()).toBe(5);
    expect(pagingButton()?.getAttribute("aria-label")).toBe("Show more");

    pagingButton()?.click();
    await settleLitElement(sidebar);

    expect(rows()).toBe(7);
    expect(pagingButton()?.getAttribute("aria-label")).toBe("Show less");

    pagingButton()?.click();
    await settleLitElement(sidebar);

    expect(rows()).toBe(5);
    expect(pagingButton()?.getAttribute("aria-label")).toBe("Show more");
  };

  it("limits project groups until the user expands them", async () => {
    const sidebar = await mountCatalog("project");

    const project = sidebar.querySelector<HTMLElement>(
      '[data-session-catalog-project="project:/workspace/openclaw"]',
    );
    const projectGroup = project?.closest<HTMLElement>(".sidebar-session-catalog-project");
    expect(projectGroup).not.toBeNull();
    await verifyExpansion(projectGroup!, sidebar);
  });

  it("limits flat host groups until the user expands them", async () => {
    const sidebar = await mountCatalog("none");
    const host = sidebar.querySelector<HTMLElement>(".sidebar-session-catalog-host");
    expect(host).not.toBeNull();
    await verifyExpansion(host!, sidebar);
  });

  it("keeps a project folder expanded across refreshes, list resets and remounts", async () => {
    const storageKey = "openclaw:sidebar:sessions:expanded-catalog-sections";
    const folderRows = (root: HTMLElement) =>
      root
        .querySelector<HTMLElement>('[data-session-catalog-project="project:/workspace/openclaw"]')
        ?.closest<HTMLElement>(".sidebar-session-catalog-project")
        ?.querySelectorAll("[data-session-key]").length;
    const sidebar = await mountCatalog("project");
    sidebar
      .querySelector<HTMLButtonElement>(
        ".sidebar-session-catalog-project .sidebar-session-pagination__button",
      )
      ?.click();
    await settleLitElement(sidebar);
    expect(folderRows(sidebar)).toBe(7);
    expect(JSON.parse(localStorage.getItem(storageKey) ?? "[]")).toHaveLength(1);

    // A catalog refresh replaces every row object; a list reset clears page-size limits.
    sidebar.sessionData.sessionCatalogs = sidebar.sessionData.sessionCatalogs.map((catalog) => ({
      ...catalog,
      hosts: catalog.hosts.map((host) => ({
        ...host,
        sessions: host.sessions.map((session) => ({ ...session })),
      })),
    }));
    sidebar.sessionData.resetSessionList();
    sidebar.sessionData.requestSessionDataUpdate();
    await settleLitElement(sidebar);
    expect(folderRows(sidebar)).toBe(7);

    sidebar.remove();
    const remounted = await mountCatalog("project");
    expect(folderRows(remounted)).toBe(7);
    const toggle = remounted.querySelector<HTMLButtonElement>(
      ".sidebar-session-catalog-project .sidebar-session-pagination__button",
    );
    expect(toggle?.getAttribute("aria-label")).toBe("Show less");
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    toggle?.click();
    await settleLitElement(remounted);
    expect(folderRows(remounted)).toBe(5);
    expect(JSON.parse(localStorage.getItem(storageKey) ?? "[]")).toEqual([]);
  });

  it("omits the control when a group has five sessions", async () => {
    const sidebar = await mountCatalog("none", 5);
    const host = sidebar.querySelector<HTMLElement>(".sidebar-session-catalog-host");

    expect(host?.querySelectorAll("[data-session-key]")).toHaveLength(5);
    expect(host?.querySelector(".sidebar-session-pagination__button")).toBeNull();
  });
});
