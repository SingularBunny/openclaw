import { parseModelCatalogRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import { normalizeModelRef } from "../../agents/model-ref-shared.js";
import { getProcessGatewayPluginMetadataSnapshot } from "../../plugins/current-plugin-metadata-state.js";

/** Resolves an ACP turn's model option against the plugin manifests captured at turn start. */
export function createAcpTurnModelRefResolver() {
  const manifestPlugins = getProcessGatewayPluginMetadataSnapshot() ?? [];
  return (model: string | undefined) => {
    const ref = model ? parseModelCatalogRef(model) : undefined;
    return ref
      ? normalizeModelRef(ref.provider, ref.modelId, {
          allowPluginNormalization: false,
          manifestPlugins,
        })
      : undefined;
  };
}
