// Fork: a reload drains past a running turn that never called the plugin it replaces.
import { afterEach, expect, it, vi } from "vitest";
import {
  captureAgentPluginRuntimeRefresh,
  createAgentPluginRuntimeRefresh,
} from "../agents/plugin-runtime-refresh.js";
import { captureTurnHandoverRequest } from "../agents/plugin-turn-handover.js";
import { retainRuntimePluginWork } from "../agents/runtime-plugin-work.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { PluginInstance } from "../plugins/plugin-instance.js";
import { withPluginRetentionOwner } from "../plugins/plugin-retention-diagnostics.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import {
  createPluginReloadCleanup,
  PluginAdmittedWorkTimeoutError,
} from "./server-plugin-reload-cleanup.js";

afterEach(() => {
  vi.useRealTimers();
});

function addPlugin(registry: PluginRegistry, id: string) {
  const record = createPluginRecord({ id, status: "loaded" });
  registry.plugins.push(record);
  return new PluginInstance(record.id, { record, registry });
}

// One gateway turn: its prepared-generation lease holds every plugin of the
// generation, exactly as the prepared plugin lifetime retains it.
function startTurn(registry: PluginRegistry, calls: PluginInstance[]) {
  return withPluginRetentionOwner({ runId: "turn", serviceId: "gateway-agent-turn" }, () =>
    createAgentPluginRuntimeRefresh().run(() => {
      captureAgentPluginRuntimeRefresh().bindConsumer(() => true);
      const release = retainRuntimePluginWork(
        [registry],
        "prepared-generation-lease",
        captureTurnHandoverRequest([registry]),
      );
      for (const instance of calls) {
        instance.run(() => "turn work");
      }
      return release;
    }),
  );
}

function drain(registry: PluginRegistry, pluginId: string) {
  const signal = new AbortController().signal;
  const cleanup = createPluginReloadCleanup({
    previousRegistry: registry,
    changedPluginIds: new Set([pluginId]),
    port: 0,
    pluginWorkspaceDir: undefined,
    getCron: () => {
      throw new Error("cron must not be called by the drain");
    },
    abortSignal: signal,
    log: createSubsystemLogger("test/unused-plugin"),
    recordCleanup: vi.fn(),
    recordWarning: vi.fn(),
    retainRetirement: vi.fn(),
  });
  return cleanup
    .drainRetainedWork(new Set([pluginId]), signal, vi.fn(), {
      includeConsumers: true,
      includeCalls: true,
    })
    .then(
      () => "drained",
      (error: unknown) => error,
    );
}

it("reloads a plugin a running turn never called without waiting for the turn", async () => {
  vi.useFakeTimers();
  const registry = createEmptyPluginRegistry();
  const acpx = addPlugin(registry, "acpx");
  const model = addPlugin(registry, "anthropic");
  const releaseTurn = startTurn(registry, [model]);
  expect(acpx.retainedWorkCount).toBe(1);

  acpx.reserveReplacement();
  const drained = drain(registry, "acpx");
  let outcome: unknown = "still waiting for the turn";
  void drained.then((result) => {
    outcome = result;
  });
  await vi.advanceTimersByTimeAsync(1_000);

  expect(outcome).toBe("drained");
  expect(acpx.retainedWorkCount).toBe(0);
  // The turn keeps the plugin it runs on.
  expect(model.retainedWorkCount).toBe(1);
  releaseTurn();
  expect(model.retainedWorkCount).toBe(0);
  await drained;
});

it("keeps waiting for a running turn that called the reloaded plugin", async () => {
  vi.useFakeTimers();
  const registry = createEmptyPluginRegistry();
  const acpx = addPlugin(registry, "acpx");
  const releaseTurn = startTurn(registry, [acpx]);

  acpx.reserveReplacement();
  const drained = drain(registry, "acpx");
  await vi.advanceTimersByTimeAsync(60_000);

  expect(await drained).toBeInstanceOf(PluginAdmittedWorkTimeoutError);
  expect(acpx.retainedWorkCount).toBe(1);
  releaseTurn();
});

it("keeps waiting for a hold taken outside any turn scope", async () => {
  vi.useFakeTimers();
  const registry = createEmptyPluginRegistry();
  const acpx = addPlugin(registry, "acpx");
  const release = retainRuntimePluginWork(
    [registry],
    "prepared-generation-lease",
    captureTurnHandoverRequest([registry]),
  );

  acpx.reserveReplacement();
  const drained = drain(registry, "acpx");
  await vi.advanceTimersByTimeAsync(60_000);

  expect(await drained).toBeInstanceOf(PluginAdmittedWorkTimeoutError);
  release();
});
