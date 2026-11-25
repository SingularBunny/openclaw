import { logVerbose } from "../../globals.js";
import type { ReplyOperation } from "../../sessions/session-controller.contracts.js";
import { markReplyOperationExecutionStarted } from "../../sessions/session-controller.state.js";

/**
 * Holds a reply operation's watchdog off while an ACP turn runs. The turn is bounded by its
 * own ACP turn timeout and the user's stop, so silence (a long build, a test run) must not
 * stop it. Returns the release; the release starts a fresh semantic window for finalization.
 * With `turnSessionKey`, the operation is the one the turn runs under, and its absence is
 * logged: such a turn has no watchdog on its session to hold.
 */
export function holdAcpTurnLiveness(
  operation: ReplyOperation | undefined,
  turnSessionKey?: string,
): () => void {
  if (!operation) {
    if (turnSessionKey) {
      logVerbose(`acp: turn for ${turnSessionKey} runs without a reply operation; nothing to hold`);
    }
    return () => {};
  }
  let held = true;
  const wait = operation.watchdog.beginWait({
    kind: "runtime_owned",
    releaseStartsSemanticWindow: true,
    isCurrent: () => held,
  });
  return () => {
    held = false;
    wait.close();
  };
}

/**
 * Fork: marks the reply operations an ACP turn runs for as executing, as embedded and CLI runs
 * mark theirs. The session list shows an operation that never started as "queued", so a chat
 * bound to an ACP agent (and the ACP session itself) kept a paused ring for the whole turn.
 * Marking also publishes the row change, so the sidebar starts spinning at once.
 */
export function markAcpTurnExecuting(...operations: Array<ReplyOperation | undefined>): void {
  for (const operation of new Set(operations)) {
    if (operation && !operation.result) {
      markReplyOperationExecutionStarted(operation);
    }
  }
}
