// Fork: a scoped auth refresh holds a reload only for plugins it calls into.
import { expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { bindPluginMetadataSnapshotCache, createPluginCache } from "../plugins/plugin-cache.js";
import { PluginInstance } from "../plugins/plugin-instance.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import type { PreparedModelCatalogAuth } from "./prepared-model-runtime-auth.js";
import {
  createPreparedAccountCatalogAccess,
  loadScopedModelCatalogAuth,
} from "./prepared-model-runtime.catalog-auth.js";
import type { PreparedModelRuntimePluginGeneration } from "./prepared-model-runtime.types.js";

function fixture(resources: AsyncDisposableStack) {
  const cache = resources.use(createPluginCache());
  const metadata = createPluginMetadataSnapshotFixture({
    plugins: [{ id: "deepseek", providers: ["deepseek"] }],
  });
  bindPluginMetadataSnapshotCache(metadata, cache);
  const registry = createEmptyPluginRegistry();
  const record = createPluginRecord({ id: "deepseek", status: "loaded" });
  registry.plugins.push(record);
  const instance = new PluginInstance(record.id, { record, registry });
  const pluginGeneration: PreparedModelRuntimePluginGeneration = {
    remoteCatalog: null,
    pluginMetadataSnapshot: metadata,
    pluginRegistry: registry,
    inlineProviderModels: [],
    configuredCatalogEntries: [],
  };
  const auth: PreparedModelCatalogAuth = {
    authStore: { version: 1, profiles: {} },
    credentials: {},
    authModes: {},
    providerAuthLabels: new Map(),
  };
  const refreshing = createDeferred();
  const refreshed = createDeferred<typeof auth>();
  const owner = {
    pluginGeneration,
    accountCatalog: createPreparedAccountCatalogAccess(() => true),
    normalizeProvider: (provider: string) => provider,
    assertCurrent: () => {},
    readAuth: () => auth,
    refreshAuth: async () => {
      refreshing.resolve();
      // The catalog worker waits on a slow provider endpoint.
      return await refreshed.promise;
    },
  };
  return { owner, instance, auth, refreshing: refreshing.promise, refreshed };
}

it("lets a reload take a plugin that a pending auth refresh never called", async () => {
  await using resources = new AsyncDisposableStack();
  const { owner, instance, auth, refreshing, refreshed } = fixture(resources);
  resources.defer(async () => {
    await instance.dispose();
  });
  const pending = loadScopedModelCatalogAuth(owner, { providerIds: ["openai"] });
  resources.defer(async () => {
    refreshed.resolve(auth);
    await pending.catch(() => undefined);
  });
  await refreshing;
  expect(instance.retainedWorkCount).toBe(1);
  expect(instance.retentionSnapshot().references[0]?.owner).toMatchObject({
    serviceId: "model-auth-refresh",
  });

  const release = instance.reserveReplacement();
  resources.defer(release);
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  expect(instance.retainedWorkCount).toBe(0);
});
