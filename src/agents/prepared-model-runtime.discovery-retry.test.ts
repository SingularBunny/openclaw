// Fork: a failed-discovery retry runs as its own plugin-use owner.
import { afterEach, expect, it, vi } from "vitest";
import { capturePluginUseScope } from "../plugins/plugin-use-scope.js";
import { createFailedDiscoveryRetry } from "./prepared-model-runtime.discovery-retry.js";
import type { PreparedModelCatalogInventory } from "./prepared-model-runtime.types.js";

afterEach(() => {
  vi.useRealTimers();
});

it("retries failed discovery in a plugin use scope of its own", async () => {
  vi.useFakeTimers({ now: 0 });
  const inventory = {
    providers: new Map([["huggingface", { discoveryFailures: 1, expiresAt: 30_000 }]]),
  } as unknown as PreparedModelCatalogInventory;
  const acquire = vi.fn(async () => capturePluginUseScope());
  const retirement = new AbortController();
  createFailedDiscoveryRetry(retirement.signal, () => inventory, acquire);

  await vi.advanceTimersByTimeAsync(30_000);
  retirement.abort();

  expect(acquire).toHaveBeenCalledWith({ providerIds: ["huggingface"], refresh: true });
  await expect(acquire.mock.results[0]?.value).resolves.toBeDefined();
});
