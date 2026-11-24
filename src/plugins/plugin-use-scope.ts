// Fork: which plugins a host scope (an agent turn, a service) has called into.
// A reload need not wait for a turn that never touched the plugin it replaces.
import { AsyncContext } from "../shared/async-context.js";

/** Plugin IDs this scope and its nested scopes have called into. */
export type PluginUseScope = { readonly pluginIds: ReadonlySet<string> };

type Recorder = { readonly pluginIds: Set<string>; readonly parent?: Recorder };

const useScope = new AsyncContext<Recorder>(Symbol.for("openclaw.pluginUseScope"));

/** Runs a host scope that records its plugin calls, also into every enclosing scope. */
export function runWithPluginUseScope<T>(run: () => T): T {
  return useScope.run({ pluginIds: new Set(), parent: useScope.getStore() }, run);
}

/** Notes a call into a plugin made on behalf of the current host scope. */
export function recordPluginUse(pluginId: string): void {
  for (let scope = useScope.getStore(); scope; scope = scope.parent) {
    scope.pluginIds.add(pluginId);
  }
}

/** The current host scope; undefined outside one, where every plugin counts as used. */
export function capturePluginUseScope(): PluginUseScope | undefined {
  return useScope.getStore();
}
