// Operator grants of api.runtime.gateway.request to plugins that are neither bundled nor trusted
// official installs. OPENCLAW_PLUGIN_GATEWAY_METHODS lists exact methods per plugin id:
//   "<plugin id>=<method>,<method>;<plugin id>=<method>"
// Read on use, so config env.vars changes apply without a restart. Granted requests keep the
// default operator.write ceiling: requested scopes stay reserved for trusted plugins, so a grant
// can never reach an admin-only method.
export const PLUGIN_GATEWAY_METHODS_ENV = "OPENCLAW_PLUGIN_GATEWAY_METHODS";

/** Plugin id → granted methods. Malformed entries and wildcards grant nothing. */
export function parsePluginGatewayMethodGrants(raw: string | undefined): Map<string, Set<string>> {
  const grants = new Map<string, Set<string>>();
  for (const entry of (raw ?? "").split(";")) {
    const separator = entry.indexOf("=");
    const pluginId = entry.slice(0, Math.max(separator, 0)).trim();
    if (!pluginId) {
      continue;
    }
    const methods = entry
      .slice(separator + 1)
      .split(",")
      .map((method) => method.trim())
      .filter((method) => method && !method.includes("*"));
    if (methods.length) {
      grants.set(pluginId, new Set([...(grants.get(pluginId) ?? []), ...methods]));
    }
  }
  return grants;
}

/** Whether the operator granted this plugin this exact Gateway method. */
export function isPluginGatewayMethodGranted(
  pluginId: string | undefined,
  method: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!pluginId) {
    return false;
  }
  return (
    parsePluginGatewayMethodGrants(env[PLUGIN_GATEWAY_METHODS_ENV]).get(pluginId)?.has(method) ===
    true
  );
}
