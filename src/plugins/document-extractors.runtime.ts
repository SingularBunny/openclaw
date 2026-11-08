/** Resolves document extractors from enabled bundled manifest contracts and live plugin registrations. */
import { formatErrorMessage } from "@openclaw/normalization-core/error-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveEnabledBundledManifestContractPlugins } from "./bundled-manifest-contract-plugins.js";
import { normalizePluginsConfig } from "./config-state.js";
import type {
  DocumentExtractorPlugin,
  PluginDocumentExtractorEntry,
} from "./document-extractor-types.js";
import { sortPluginEntriesForAutoDetect } from "./plugin-entry-order.js";
import { getPluginInstance } from "./plugin-instance-scope.js";
import { createPluginIdScopeSet } from "./plugin-scope.js";
import { loadBundledPublicArtifactEntries } from "./public-artifact-factories.js";
import { getPluginRegistryForContext } from "./runtime/gateway-request-scope.js";

const log = createSubsystemLogger("plugins");

/** Returns enabled document extractors in deterministic auto-detect order. */
export function resolvePluginDocumentExtractors(params?: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  onlyPluginIds?: readonly string[];
}): PluginDocumentExtractorEntry[] {
  const extractors: PluginDocumentExtractorEntry[] = [];
  const loadErrors: unknown[] = [];
  let onlyPluginIds = params?.onlyPluginIds;
  const pluginsConfig = normalizePluginsConfig(params?.config?.plugins);
  const allowlist = pluginsConfig.allow;
  if (allowlist.length > 0) {
    // Document allowlists stay restrictive when upgrade compatibility broadens activation.
    const scope = createPluginIdScopeSet(onlyPluginIds);
    onlyPluginIds = allowlist.filter((pluginId) => !scope || scope.has(pluginId));
  }
  for (const plugin of resolveEnabledBundledManifestContractPlugins({
    config: params?.config,
    workspaceDir: params?.workspaceDir,
    env: params?.env,
    onlyPluginIds,
    contract: "documentExtractors",
  })) {
    let loaded: PluginDocumentExtractorEntry[] | null;
    try {
      loaded = loadBundledPublicArtifactEntries({
        dirName: plugin.id,
        pluginId: plugin.id,
        env: params?.env,
        owner: plugin,
        artifactCandidates: ["document-extractor.js", "document-extractor-api.js"],
        suffix: "DocumentExtractor",
        isArtifact: (value): value is DocumentExtractorPlugin =>
          isRecord(value) &&
          typeof value.id === "string" &&
          typeof value.label === "string" &&
          Array.isArray(value.mimeTypes) &&
          value.mimeTypes.every((mimeType) => typeof mimeType === "string" && mimeType.trim()) &&
          (value.autoDetectOrder === undefined || typeof value.autoDetectOrder === "number") &&
          typeof value.extract === "function",
        partialFailureLabel: "document extractors",
      });
    } catch (error) {
      loadErrors.push(error);
      continue;
    }
    if (loaded) {
      extractors.push(...loaded);
    }
  }
  // Installed plugins register extractors at runtime; the live registry holds only loaded owners.
  if (pluginsConfig.enabled) {
    const registry = getPluginRegistryForContext();
    const scope = createPluginIdScopeSet(onlyPluginIds);
    for (const { pluginId, provider } of registry?.documentExtractors ?? []) {
      if (
        (scope && !scope.has(pluginId)) ||
        pluginsConfig.deny.includes(pluginId) ||
        pluginsConfig.entries[pluginId]?.enabled === false ||
        extractors.some((entry) => entry.pluginId === pluginId && entry.id === provider.id)
      ) {
        continue;
      }
      const record = registry?.plugins.find((entry) => entry.id === pluginId);
      const instance = record && getPluginInstance(record);
      extractors.push(Object.assign({}, instance?.wrap(provider) ?? provider, { pluginId }));
    }
  }
  if (extractors.length === 0 && loadErrors.length > 0) {
    throw new Error("Unable to load document extractor plugins", {
      cause: loadErrors.length === 1 ? loadErrors[0] : new AggregateError(loadErrors),
    });
  }
  for (const error of loadErrors) {
    log.warn("Unable to load some document extractor plugins; using healthy extractors", {
      error,
      detail: formatErrorMessage(error),
    });
  }
  return sortPluginEntriesForAutoDetect(extractors);
}
