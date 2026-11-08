// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
vi.mock("../lib/gateway-methods.ts", () => ({ canCallGatewayMethod: () => true }));

const { subscribeSessionDataGatewayEvents } = await import("./session-data-controller-events.ts");

function harness() {
  let listener: ((event: { event: string; payload?: unknown }) => void) | undefined;
  const gateway = {
    snapshot: {},
    subscribeEvents: (handler: (event: { event: string; payload?: unknown }) => void) => {
      listener = handler;
      return () => undefined;
    },
  };
  const owner = {
    presencePayload: undefined,
    handleSessionCatalogHostEvent: vi.fn(),
    handleSessionCatalogChanged: vi.fn(),
    handlePluginSessionCatalogChanged: vi.fn(),
    requestSessionDataUpdate: vi.fn(),
  };
  subscribeSessionDataGatewayEvents(gateway as never, owner);
  return { emit: (event: string) => listener?.({ event, payload: {} }), owner };
}

describe("plugin session catalog change events", () => {
  it("refreshes catalogs on plugin.<id>.session-catalog-changed only", () => {
    const { emit, owner } = harness();
    emit("plugin.aiwb-claude-bridge.session-catalog-changed");
    emit("plugin.aiwb-claude-bridge.something-else");
    emit("plugin.session-catalog-changed");
    expect(owner.handlePluginSessionCatalogChanged).toHaveBeenCalledTimes(1);
    expect(owner.handleSessionCatalogChanged).not.toHaveBeenCalled();
  });
});
