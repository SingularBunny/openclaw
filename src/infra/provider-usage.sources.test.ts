import { afterEach, describe, expect, it, vi } from "vitest";
import { capturePluginUseScope } from "../plugins/plugin-use-scope.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import type { OpenClawPluginUsageSource } from "../plugins/types.js";
import { formatUsageReportLines, formatUsageWindowSummary } from "./provider-usage.format.js";
import { loadProviderUsageSummary } from "./provider-usage.load.js";
import { collectPluginUsageSnapshots, hasPluginUsageSources } from "./provider-usage.sources.js";
import type { ProviderUsageSnapshot } from "./provider-usage.types.js";

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: () => ({}),
}));

const activeRegistry = vi.hoisted(() => ({ current: null as PluginRegistry | null }));
vi.mock("../plugins/runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/runtime.js")>()),
  getActivePluginRegistry: () => activeRegistry.current,
}));

const balanceEntry: ProviderUsageSnapshot = {
  provider: "acp-junie",
  displayName: "Junie",
  windows: [],
  plan: "Example AI Ultimate",
  billing: [{ type: "balance", label: "Balance left", amount: 42.5, unit: "credits" }],
  observedAt: Date.UTC(2026, 0, 7, 11, 55),
};

function registryWith(...sources: OpenClawPluginUsageSource[]): PluginRegistry {
  const registry = createEmptyPluginRegistry();
  registry.usageSources.push(
    ...sources.map((usageSource) => ({ pluginId: "acpx", source: "test", usageSource })),
  );
  return registry;
}

afterEach(() => {
  activeRegistry.current = null;
  vi.useRealTimers();
});

describe("collectPluginUsageSnapshots", () => {
  it("collects each source inside its own plugin use scope", async () => {
    let scoped = false;
    const registry = registryWith({
      id: "acp-agents",
      collect: () => {
        scoped = capturePluginUseScope() !== undefined;
        return [balanceEntry];
      },
    });
    expect(hasPluginUsageSources(registry)).toBe(true);
    await expect(
      collectPluginUsageSnapshots({ config: {}, env: {}, timeoutMs: 1000, registry }),
    ).resolves.toEqual([{ ...balanceEntry, usageOnly: true }]);
    expect(scoped).toBe(true);
  });

  it("drops a failing or late source and keeps the rest", async () => {
    const registry = registryWith(
      { id: "broken", collect: () => Promise.reject(new Error("boom")) },
      { id: "late", collect: () => new Promise(() => {}) },
      { id: "good", collect: () => [balanceEntry, { ...balanceEntry, displayName: "dup" }] },
      // Malformed entries are skipped; a missing name falls back to the id.
      { id: "loose", collect: () => [{ provider: "acp-x" } as ProviderUsageSnapshot, {} as never] },
    );
    await expect(
      collectPluginUsageSnapshots({ config: {}, env: {}, timeoutMs: 50, registry }),
    ).resolves.toEqual([
      { ...balanceEntry, usageOnly: true },
      { provider: "acp-x", displayName: "acp-x", windows: [], usageOnly: true },
    ]);
  });

  it("does nothing without sources", async () => {
    const registry = createEmptyPluginRegistry();
    expect(hasPluginUsageSources(registry)).toBe(false);
    await expect(
      collectPluginUsageSnapshots({ config: {}, env: {}, timeoutMs: 1000, registry }),
    ).resolves.toEqual([]);
  });
});

describe("loadProviderUsageSummary with usage sources", () => {
  it("lists a source entry next to provider usage on unfiltered reads only", async () => {
    activeRegistry.current = registryWith({ id: "acp-agents", collect: () => [balanceEntry] });
    const all = await loadProviderUsageSummary({ providers: [], includeUsageSources: true });
    expect(all.providers).toEqual([{ ...balanceEntry, usageOnly: true }]);
    const filtered = await loadProviderUsageSummary({ providers: [] });
    expect(filtered.providers).toEqual([]);
  });

  it("keeps a source's error entry visible", async () => {
    activeRegistry.current = registryWith({
      id: "acp-agents",
      collect: () => [
        {
          provider: "acp-junie",
          displayName: "Junie",
          windows: [],
          error: "The agent is not logged in",
        },
      ],
    });
    const summary = await loadProviderUsageSummary({ providers: [], includeUsageSources: true });
    expect(summary.providers).toEqual([
      {
        provider: "acp-junie",
        displayName: "Junie",
        windows: [],
        error: "The agent is not logged in",
        usageOnly: true,
      },
    ]);
  });
});

describe("usage text for a source entry", () => {
  it("renders the balance, plan and age", () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 0, 7, 12, 0));
    expect(formatUsageReportLines({ updatedAt: Date.now(), providers: [balanceEntry] })).toEqual([
      "Usage:",
      "  Junie (Example AI Ultimate)",
      "    Balance left: 42.50 credits",
      "    Checked 5m ago",
    ]);
    expect(formatUsageWindowSummary(balanceEntry)).toBe("Balance left: 42.50 credits");
    expect(
      formatUsageReportLines({
        updatedAt: Date.now(),
        providers: [{ provider: "acp-junie", displayName: "Junie", windows: [], refreshing: true }],
      }),
    ).toEqual(["Usage:", "  Junie: checking…"]);
  });
});
