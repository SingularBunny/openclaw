// Fork: a refresh on a connection with a cached page is answered from the cache at once (pending
// hosts), so a slower provider's fresh host reaches that client only through onHost. Plugin providers
// that list in one step (aiwb-claude-bridge "projects") publish their host there as well.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  call,
  hoisted,
  provider,
  resetSessionCatalogTestState,
  startCall,
  type SessionCatalogProvider,
} from "./session-catalog.test-helpers.js";

beforeEach(() => {
  resetSessionCatalogTestState();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

const oldHost = {
  hostId: "gateway:local",
  label: "Projects",
  kind: "gateway" as const,
  connected: true,
  sessions: [],
};
const freshHost = {
  ...oldHost,
  sessions: [
    {
      threadId: "s:agent:main:main",
      name: "main",
      status: "running" as const,
      archived: false,
      canContinue: true,
      canArchive: false,
    },
  ],
};

async function refreshFromCache(publishes: boolean) {
  const settle = createDeferredCore();
  const list = vi
    .fn<SessionCatalogProvider["list"]>()
    .mockResolvedValueOnce([oldHost])
    .mockImplementation(async (params) => {
      await settle.promise;
      if (publishes) {
        params.onHost?.(freshHost);
      }
      return [freshHost];
    });
  hoisted.activeRegistry.sessionCatalogs = [{ provider: provider("projects", { list }) }];
  const config = {};
  const client = { connId: "owner" };
  const query = { allowPartialResults: true, progressId: "refresh" };
  const broadcastToConnIds = vi.fn();
  const context = { broadcastToConnIds };
  await call("sessions.catalog.list", query, config, client, context);
  const refresh = startCall("sessions.catalog.list", query, config, client, context);
  await vi.advanceTimersByTimeAsync(0);
  // Answered from the cache before the provider settles: the client keeps its rows for this host.
  expect(refresh.respond).toHaveBeenCalledWith(true, {
    catalogs: [
      expect.objectContaining({
        hosts: [{ ...oldHost, pending: true }],
        error: expect.objectContaining({ code: "catalog_pending" }),
      }),
    ],
  });
  await refresh.completion;
  broadcastToConnIds.mockClear();
  settle.resolve();
  await vi.advanceTimersByTimeAsync(0);
  return broadcastToConnIds;
}

it("delivers the fresh host of a provider that settles after a cached answer through onHost", async () => {
  const broadcast = await refreshFromCache(true);
  expect(broadcast).toHaveBeenCalledWith(
    "sessions.catalog.host",
    expect.objectContaining({
      progressId: "refresh",
      catalog: expect.objectContaining({ id: "projects", hosts: [freshHost] }),
    }),
    new Set(["owner"]),
    { dropIfSlow: true },
  );
});

it("does not deliver a host the provider only returns after a cached answer", async () => {
  const broadcast = await refreshFromCache(false);
  expect(broadcast).not.toHaveBeenCalled();
});
