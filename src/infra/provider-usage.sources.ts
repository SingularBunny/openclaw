// Fork: account usage contributed by plugin usage sources (ACP agents and other
// runtimes that are not model providers) next to provider usage.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { withPluginRetentionOwner } from "../plugins/plugin-retention-diagnostics.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import { formatErrorMessage } from "./errors.js";
import { raceUsageTimeout } from "./provider-usage.shared.js";
import type { ProviderUsageSnapshot } from "./provider-usage.types.js";

const log = createSubsystemLogger("provider-usage-sources");

type UsageSourceRegistration = PluginRegistry["usageSources"][number];

function listUsageSources(registry?: PluginRegistry | null): UsageSourceRegistration[] {
  return (registry === undefined ? getActivePluginRegistry() : registry)?.usageSources ?? [];
}

/** True when a loaded plugin contributes account usage outside model providers. */
export function hasPluginUsageSources(registry?: PluginRegistry | null): boolean {
  return listUsageSources(registry).length > 0;
}

function normalizeSnapshot(value: unknown): ProviderUsageSnapshot | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const snapshot = value as Partial<ProviderUsageSnapshot>;
  const provider = typeof snapshot.provider === "string" ? snapshot.provider.trim() : "";
  if (!provider) {
    return undefined;
  }
  return {
    ...snapshot,
    provider,
    displayName:
      typeof snapshot.displayName === "string" && snapshot.displayName.trim()
        ? snapshot.displayName.trim()
        : provider,
    windows: Array.isArray(snapshot.windows) ? snapshot.windows : [],
    usageOnly: true,
  };
}

/**
 * Collects every usage source within the provider-usage deadline. A source that
 * fails or misses the deadline drops out; it never breaks provider usage.
 * Each call runs in its own retention owner, so a plugin reload waits only for
 * the sources this read actually called into.
 */
export async function collectPluginUsageSnapshots(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  registry?: PluginRegistry | null;
}): Promise<ProviderUsageSnapshot[]> {
  const sources = listUsageSources(params.registry);
  if (sources.length === 0 || params.timeoutMs <= 0) {
    return [];
  }
  const results = await Promise.all(
    sources.map((entry) =>
      withPluginRetentionOwner({ serviceId: "provider-usage" }, () =>
        raceUsageTimeout(
          async (signal) => {
            const snapshots = await entry.usageSource.collect({
              config: params.config,
              env: params.env,
              signal,
              timeoutMs: params.timeoutMs,
            });
            return Array.isArray(snapshots) ? snapshots : [];
          },
          params.timeoutMs,
          [] as ProviderUsageSnapshot[],
        ),
      ).catch((error: unknown) => {
        log.debug(
          `usage source ${entry.pluginId}/${entry.usageSource.id} failed: ${formatErrorMessage(error)}`,
        );
        return [] as ProviderUsageSnapshot[];
      }),
    ),
  );
  const seen = new Set<string>();
  const snapshots: ProviderUsageSnapshot[] = [];
  for (const value of results.flat()) {
    const snapshot = normalizeSnapshot(value);
    if (snapshot && !seen.has(snapshot.provider)) {
      seen.add(snapshot.provider);
      snapshots.push(snapshot);
    }
  }
  return snapshots;
}
