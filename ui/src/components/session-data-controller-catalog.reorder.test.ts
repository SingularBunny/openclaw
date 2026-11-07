import { describe, expect, it, vi } from "vitest";
import type {
  SessionCatalog,
  SessionsCatalogReorderParams,
} from "../../../packages/gateway-protocol/src/index.ts";
import type { SidebarCatalogSessionMutationScope } from "./app-sidebar-session-types.ts";
import { reorderSessionCatalog } from "./session-data-controller-catalog.ts";

function catalogs(): SessionCatalog[] {
  const row = (threadId: string, customGroup: string) => ({
    threadId,
    customGroup,
    status: "stored",
    archived: false,
    canContinue: false,
    canArchive: false,
  });
  return [
    {
      id: "claude",
      label: "Claude",
      capabilities: { continueSession: false, archive: false, reorder: true },
      hosts: [
        {
          hostId: "gateway:local",
          label: "Local",
          kind: "gateway",
          connected: true,
          sessions: [row("a1", "Alpha"), row("b1", "Beta")],
        },
      ],
    },
  ];
}

function setup(request: (method: string, params: unknown) => Promise<unknown>) {
  const owner = {
    sessionCatalogs: catalogs(),
    sessionCatalogRevision: 0,
    sessionScopeGeneration: 3,
    requestSessionDataUpdate: vi.fn(),
    isSessionMutationScopeCurrent: vi.fn(() => true),
    invalidateSessionCatalogs: vi.fn(),
  };
  const scope = {
    client: { request: vi.fn(request) },
    catalogGeneration: 3,
  } as unknown as SidebarCatalogSessionMutationScope;
  const params: SessionsCatalogReorderParams = {
    catalogId: "claude",
    hostId: "gateway:local",
    agentId: "main",
    target: { kind: "groups", order: ["Beta", "Alpha"] },
  };
  const run = () =>
    reorderSessionCatalog(
      owner as unknown as Parameters<typeof reorderSessionCatalog>[0],
      scope,
      params,
    );
  const order = () => owner.sessionCatalogs[0]!.hosts[0]!.sessions.map((row) => row.threadId);
  return { owner, scope, params, run, order };
}

describe("reorderSessionCatalog", () => {
  it("shows the new order before the Gateway answers and then refreshes catalogs", async () => {
    let resolve: (value: unknown) => void = () => {};
    const { owner, scope, params, run, order } = setup(
      () => new Promise((settle) => (resolve = settle)),
    );

    const pending = run();
    expect(order()).toEqual(["b1", "a1"]);
    expect(owner.invalidateSessionCatalogs).not.toHaveBeenCalled();

    resolve({ ok: true });
    await pending;
    expect(scope.client.request).toHaveBeenCalledWith("sessions.catalog.reorder", params);
    expect(owner.invalidateSessionCatalogs).toHaveBeenCalledOnce();
    expect(order()).toEqual(["b1", "a1"]);
  });

  it("restores the previous order and rethrows when the Gateway rejects it", async () => {
    const { owner, run, order } = setup(async () => {
      throw new Error("catalog cannot reorder");
    });
    const previous = owner.sessionCatalogs;

    await expect(run()).rejects.toThrow("catalog cannot reorder");
    expect(owner.sessionCatalogs).toBe(previous);
    expect(order()).toEqual(["a1", "b1"]);
    expect(owner.invalidateSessionCatalogs).not.toHaveBeenCalled();
  });
});
