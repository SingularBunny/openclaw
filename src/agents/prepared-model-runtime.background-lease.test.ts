// Fork: background model-catalog work holds a reload only for plugins it calls into.
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { usePreparedModelRuntimeHarness } from "./prepared-model-runtime.test-harness.js";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createPluginReloadCleanup } from "../gateway/server-plugin-reload-cleanup.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { PluginInstance } from "../plugins/plugin-instance.js";
import { createTestPluginRegistry } from "../plugins/registry-runtime.test-helpers.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { withPreparedModelCatalogOwner } from "./prepared-model-catalog.js";
import {
  getPreparedModelRuntimeSnapshot as readSnapshot,
  refreshPreparedModelRuntimeSnapshots as refresh,
} from "./prepared-model-runtime.js";

const fixture = usePreparedModelRuntimeHarness({ label: "prepared-runtime-background-lease" });

async function publishWithPlugin(pluginId: string) {
  const { registry } = createTestPluginRegistry();
  const record = createPluginRecord({ id: pluginId, status: "loaded" });
  registry.plugins.push(record);
  const instance = new PluginInstance(record.id, { record, registry });
  fixture.mocks.loadAgentRuntimePluginRegistryHandle.mockReturnValue(registry);
  fixture.mocks.authStorage.getAll.mockReturnValue({});
  fixture.mocks.configuredAgentIds = ["default"];
  await refresh({}, { gatewayLifecycle: true });
  const input = fixture.agentInput("default", {});
  const owner = readSnapshot(input)!;
  // Settle startup discovery so the acquisition below runs with this test's worker.
  await owner.loadFullModelCatalog!();
  return { instance, owner, input, registry };
}

// The Gateway's reload drain, bounded so a held plugin reports instead of timing out.
async function drain(registry: PluginRegistry, pluginId: string) {
  const controller = new AbortController();
  const cleanup = createPluginReloadCleanup({
    previousRegistry: registry,
    changedPluginIds: new Set([pluginId]),
    port: 0,
    pluginWorkspaceDir: undefined,
    getCron: () => {
      throw new Error("cron must not be called by the drain");
    },
    abortSignal: controller.signal,
    log: createSubsystemLogger("test/background-lease"),
    recordCleanup: vi.fn(),
    recordWarning: vi.fn(),
    retainRetirement: vi.fn(),
  });
  const drained = cleanup
    .drainRetainedWork(new Set([pluginId]), controller.signal, vi.fn(), {
      includeConsumers: true,
      includeCalls: true,
    })
    .then(
      () => "drained",
      (error: unknown) => error,
    );
  const waiting = new Promise<string>((resolve) => {
    setTimeout(() => resolve("still waiting for the catalog"), 2_000).unref();
  });
  const outcome = await Promise.race([drained, waiting]);
  controller.abort();
  await drained;
  return outcome;
}

// A provider discovery that waits on a slow endpoint, as the catalog worker does
// while a provider's model list times out.
function holdDiscovery(onDiscovery?: () => void) {
  const discovering = createDeferred();
  const endpoint = createDeferred();
  fixture.mocks.runPreparedModelCatalogWorker.mockImplementationOnce(async () => {
    onDiscovery?.();
    discovering.resolve();
    await endpoint.promise;
    return { entries: [], routeVariants: [] };
  });
  return { discovering: discovering.promise, finish: () => endpoint.resolve() };
}

async function settle() {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

function leaseOwners(instance: PluginInstance) {
  return instance
    .retentionSnapshot()
    .references.filter((reference) => reference.reason === "prepared-generation-lease")
    .map((reference) => reference.owner);
}

it("lets a reload take a plugin that a pending provider discovery never called", async () => {
  const { instance, owner, registry } = await publishWithPlugin("deepseek");
  const baseline = instance.retainedWorkCount;
  const discovery = holdDiscovery();
  const pending = owner.loadFullModelCatalog!({ refresh: true });
  let release = () => {};
  try {
    await discovery.discovering;
    expect(instance.retainedWorkCount).toBe(baseline + 1);
    const owners = leaseOwners(instance);

    release = instance.reserveReplacement();
    expect(await drain(registry, "deepseek")).toBe("drained");
    expect(instance.retainedWorkCount).toBe(baseline);
    expect(owners).toContainEqual(expect.objectContaining({ serviceId: "model-catalog" }));
  } finally {
    discovery.finish();
    await pending.catch(() => undefined);
    release();
    await instance.dispose();
  }
});

it("keeps a plugin that the pending provider discovery called", async () => {
  const { instance, owner } = await publishWithPlugin("deepseek");
  const baseline = instance.retainedWorkCount;
  const discovery = holdDiscovery(() => instance.run(() => "provider hook"));
  const pending = owner.loadFullModelCatalog!({ refresh: true });
  let release = () => {};
  try {
    await discovery.discovering;
    release = instance.reserveReplacement();
    await settle();
    expect(instance.retainedWorkCount).toBe(baseline + 1);
  } finally {
    discovery.finish();
    await pending.catch(() => undefined);
    release();
    await instance.dispose();
  }
  expect(instance.retainedWorkCount).toBe(baseline);
});

it("lets a reload take a plugin that a catalog read never called", async () => {
  const { instance, input } = await publishWithPlugin("acpx");
  const baseline = instance.retainedWorkCount;
  let release = () => {};
  await withPreparedModelCatalogOwner(
    { config: input.config, agentId: input.agentId, agentDir: input.agentDir },
    async () => {
      expect(instance.retainedWorkCount).toBeGreaterThan(baseline);
      expect(leaseOwners(instance)).toContainEqual(
        expect.objectContaining({ serviceId: "model-catalog-read" }),
      );
      release = instance.reserveReplacement();
      await settle();
      expect(instance.retainedWorkCount).toBe(baseline);
    },
  );
  release();
  await instance.dispose();
});
