import { describe, expect, it } from "vitest";
import { collectPluginUsageSnapshots } from "../infra/provider-usage.sources.js";
import { expectDiagnostic, registrationFixture } from "./registry-registration.test-support.js";

const entry = { provider: "acp-agent", displayName: "Agent", windows: [] };

describe("plugin registry usage sources", () => {
  it("registers a usage source the host can collect from", async () => {
    const { registry, register } = registrationFixture();
    register({ id: "acpx" }, (api) =>
      api.registerUsageSource({ id: "acp-agents", collect: async () => [entry] }),
    );
    expect(registry.usageSources).toMatchObject([
      { pluginId: "acpx", usageSource: { id: "acp-agents" } },
    ]);
    await expect(
      collectPluginUsageSnapshots({ config: {}, env: {}, timeoutMs: 1000, registry }),
    ).resolves.toEqual([{ ...entry, usageOnly: true }]);
  });

  it("rejects a source without id or collect, and a duplicate id", () => {
    const { registry, register } = registrationFixture();
    register({ id: "acpx" }, (api) => {
      api.registerUsageSource({ id: " ", collect: () => [] });
      api.registerUsageSource({ id: "x" } as never);
      api.registerUsageSource({ id: "dup", collect: () => [] });
      api.registerUsageSource({ id: "dup", collect: () => [] });
    });
    expect(registry.usageSources.map(({ usageSource }) => usageSource.id)).toEqual(["dup"]);
    expectDiagnostic(registry, {
      level: "error",
      pluginId: "acpx",
      message: "usage source already registered: dup",
    });
  });
});
