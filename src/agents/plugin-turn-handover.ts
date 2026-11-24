// Hands running turns to a reloaded plugin at their next step boundary (#182024).
import { createSubsystemLogger } from "../logging/subsystem.js";
import { collectRegistryInvocationInstances } from "../plugins/plugin-invocation-scope.js";
import { pluginHandsOverTurns } from "../plugins/plugin-turn-handover-eligibility.js";
import { capturePluginUseScope } from "../plugins/plugin-use-scope.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import { captureAgentPluginRuntimeRefresh } from "./plugin-runtime-refresh.js";

const log = createSubsystemLogger("agents/plugin-turn-handover");

// Every plugin these registries hold that a reload has reserved.
function reservedPluginIds(registries: readonly PluginRegistry[]): Set<string> {
  const reserved = new Set<string>();
  for (const registry of registries) {
    for (const instance of collectRegistryInvocationInstances(registry)) {
      if (instance.replacementPending) {
        reserved.add(instance.pluginId);
      }
    }
  }
  return reserved;
}

/**
 * Captures how a prepared-generation hold reacts to reloads reserving plugins it
 * holds. A reload reserves all of its plugins in one pass, so the decision waits a
 * microtask and then covers every reserved plugin the hold carries. The hold hands
 * over only when all of them hand over; one plugin that can't keeps today's wait
 * for the whole turn, because parking would leave that plugin's hold in place.
 *
 * - Inside a turn, the hold asks the turn to stop at its next step boundary and
 *   keeps its work count, so the reload's drain waits for that boundary. The run
 *   then releases this generation and continues on the published one through
 *   the existing plugin-runtime refresh continuation.
 * - Outside a turn (admission and dispatch leases kept for a whole run), the
 *   hold yields its work count but keeps its custody. A later fresh call into
 *   the replaced plugin waits for the reload and rebinds to the current registry.
 *
 * Fork: a hold taken inside a host scope that records plugin use (a turn) keeps
 * only plugins that scope has called into. A reserved plugin the turn never
 * called yields at once and takes no part in the decision above, so a long turn
 * does not hold up the reload of a plugin it does not use. A hold taken outside
 * such a scope treats every plugin it holds as used.
 */
export function captureTurnHandoverRequest(
  registries: Iterable<PluginRegistry>,
): (pluginId: string, yieldHold: () => void) => void {
  const refresh = captureAgentPluginRuntimeRefresh();
  const useScope = capturePluginUseScope();
  const used = (pluginId: string) => !useScope || useScope.pluginIds.has(pluginId);
  const held = [...registries];
  const yields: Array<{ pluginId: string; yieldHold: () => void }> = [];
  let scheduled = false;
  // Reserved plugins this hold keeps for its work: the ones its turn has called into.
  const reservedUsed = () => [...reservedPluginIds(held)].filter(used);
  // Every plugin the reload reserved is still reserved, and every one can hand over.
  const handoverReady = () => {
    const reserved = reservedUsed();
    return (
      reserved.length > 0 && reserved.every((pluginId) => pluginHandsOverTurns(held, pluginId))
    );
  };
  const decide = () => {
    scheduled = false;
    const pendingYields: Array<() => void> = [];
    const unused = new Set<string>();
    for (const { pluginId, yieldHold } of yields.splice(0)) {
      if (used(pluginId)) {
        pendingYields.push(yieldHold);
      } else {
        unused.add(pluginId);
        yieldHold();
      }
    }
    if (unused.size) {
      log.info(`reload of ${[...unused].join(", ")} does not wait for a turn that never called it`);
    }
    const reserved = reservedUsed();
    const pinning = reserved.filter((pluginId) => !pluginHandsOverTurns(held, pluginId));
    if (!reserved.length || pinning.length) {
      if (pinning.length) {
        log.info(`reload of ${pinning.join(", ")} waits for the turn: no reload.turnHandover`);
      }
      return;
    }
    const plugins = reserved.join(", ");
    if (!refresh.isOwned()) {
      log.info(`plugin ${plugins} reload requested; whole-run hold yields to the reload`);
      pendingYields.forEach((yieldHold) => yieldHold());
      return;
    }
    const requested = refresh.request("reload", handoverReady);
    log.info(
      requested
        ? `plugin ${plugins} reload requested; turn will continue on the new generation at its next step boundary`
        : `plugin ${plugins} reload requested; turn has no step that can hand over, so the reload waits for it`,
    );
  };
  return (pluginId, yieldHold) => {
    yields.push({ pluginId, yieldHold });
    if (!scheduled) {
      scheduled = true;
      queueMicrotask(decide);
    }
  };
}
