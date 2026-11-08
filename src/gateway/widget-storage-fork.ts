import { copyWidgetStorageForFork } from "../canvas/widget-storage.js";
import { formatErrorMessage } from "../infra/errors.js";
import { sessionLog } from "./session-log.js";
import { sessionObserverScopeKey } from "./session-observer-model.js";

type ForkSessionIdentity = { sessionKey: string; agentId: string };

/**
 * Gives a forked session a copy of its parent's inline widget state, so widgets
 * in the copied history open where the parent left them. The copy is a
 * convenience: any failure is logged and the fork itself still succeeds.
 */
export async function copyForkedWidgetStorage(params: {
  source: ForkSessionIdentity;
  target: ForkSessionIdentity;
  loadHistory: () => Promise<readonly unknown[]>;
  stateDir?: string;
}): Promise<void> {
  try {
    const result = await copyWidgetStorageForFork({
      sourceScopeKey: sessionObserverScopeKey(params.source.sessionKey, params.source.agentId),
      targetScopeKey: sessionObserverScopeKey(params.target.sessionKey, params.target.agentId),
      loadHistory: params.loadHistory,
      ...(params.stateDir ? { stateDir: params.stateDir } : {}),
    });
    for (const { docId, reason } of result.skipped) {
      sessionLog.warn(`Forked session starts with empty widget storage for ${docId}: ${reason}`);
    }
  } catch (error) {
    sessionLog.warn(
      `Widget storage was not copied to the forked session: ${formatErrorMessage(error)}`,
    );
  }
}
