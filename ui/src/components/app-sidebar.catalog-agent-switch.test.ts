/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../test/helpers/promise.js";
import type { ApplicationGatewaySnapshot } from "../app/context.ts";
import {
  catalogPage,
  createGatewayHarness,
  createSessions,
  mountSidebar,
  TWO_AGENTS,
  type SidebarLifecycleState,
} from "../test-helpers/app-sidebar.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../test-helpers/gateway-client.ts";
import "../test-helpers/app-sidebar-suite.ts";
import { settleLitElement } from "../test-helpers/lit-settle.ts";
import "./app-sidebar.tsx";

async function settle(sidebar: SidebarLifecycleState) {
  await vi.advanceTimersByTimeAsync(0);
  await settleLitElement(sidebar);
}

// Fork (F31): a catalog such as the Projects tree lists every agent's sessions, so opening
// another agent's chat must not blank it while the background refresh runs.
describe("AppSidebar catalog rows across agent switches", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("keeps catalog rows on screen while the new agent's refresh is pending", async () => {
    const refresh = deferred<ReturnType<typeof catalogPage>>();
    const request = createGatewayRequestMock()
      .mockResolvedValueOnce(catalogPage([{ threadId: "shared", name: "Shared project chat" }]))
      .mockReturnValueOnce(refresh.promise);
    const gateway = createGatewayHarness(createTestGatewayClient(request));
    gateway.publish({
      hello: {
        auth: { role: "operator", scopes: ["operator.read"] },
        features: { methods: ["sessions.catalog.list"], events: ["sessions.catalog.changed"] },
      } as ApplicationGatewaySnapshot["hello"],
    });
    try {
      const { sidebar, context } = await mountSidebar(
        gateway.gateway,
        createSessions("main", ["agent:main:main"]),
        "panel",
        TWO_AGENTS,
      );
      sidebar.connected = true;
      await sidebar.updateComplete;
      await settle(sidebar);
      expect(sidebar.textContent).toContain("Shared project chat");
      expect(sidebar.sessionData.sessionCatalogRefreshStatus.hasLoaded).toBe(true);

      context.agentSelection.state.selectedId = "research";
      context.agentSelection.state.scopeId = "research";
      sidebar.requestUpdate();
      await settleLitElement(sidebar);
      await vi.advanceTimersByTimeAsync(200);
      await settle(sidebar);

      expect(request).toHaveBeenLastCalledWith(
        "sessions.catalog.list",
        expect.objectContaining({ agentId: "research" }),
      );
      expect(sidebar.textContent).toContain("Shared project chat");
      expect(sidebar.sessionData.sessionCatalogs).toHaveLength(1);
      expect(sidebar.sessionData.sessionCatalogRefreshStatus.hasLoaded).toBe(true);

      refresh.resolve(catalogPage([{ threadId: "fresh", name: "Fresh project chat" }]));
      await settle(sidebar);
      expect(sidebar.textContent).toContain("Fresh project chat");
      expect(sidebar.textContent).not.toContain("Shared project chat");
    } finally {
      refresh.resolve(catalogPage([]));
    }
  });
});
