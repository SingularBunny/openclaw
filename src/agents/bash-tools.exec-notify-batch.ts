import { replyRunRegistry } from "../auto-reply/reply/reply-run-registry.js";
import type {
  SessionEventReceipt,
  SessionEventTarget,
} from "../auto-reply/reply/session-event-contract.js";
/**
 * Fork: background exec completions that arrive while their session is running a turn wait
 * for that turn to end and then reach the session as one event, so several finished commands
 * wake the agent once instead of once per command.
 */
import { enqueueSessionEventForHost as enqueueSessionEvent } from "../auto-reply/reply/session-event-handoff.js";
import { formatErrorMessage } from "../infra/errors.js";
import { type ExecRequestOwner, withExecRequestOwners } from "../infra/exec-request-context.js";
import { logWarn } from "../logger.js";
import type { DeliveryContext } from "../utils/delivery-context.types.js";

export type ExecExitNotice = {
  /** Process session id; the queue key and the context key of a single notice. */
  id: string;
  /** Registry instance id of the process, stable across id reuse. */
  instanceId: string;
  text: string;
  agentId: string;
  sessionKey: string;
  target: SessionEventTarget;
  owners?: readonly ExecRequestOwner[];
  deliveryContext?: DeliveryContext;
  /** True once the agent has read the process result itself; the notice is then dropped. */
  isObsolete: () => boolean;
};

type PendingBatch = { notices: ExecExitNotice[]; waiting: boolean };

const pending = new Map<string, PendingBatch>();

type Deps = {
  isSessionBusy: (sessionKey: string) => boolean;
  waitForIdle: (sessionKey: string) => Promise<unknown>;
  enqueue: typeof enqueueSessionEvent;
};

const defaultDeps: Deps = {
  isSessionBusy: (sessionKey) => replyRunRegistry.isActive(sessionKey),
  waitForIdle: (sessionKey) => replyRunRegistry.waitForIdle(sessionKey, null),
  // Resolve the binding per call so module-level spies and reloads see each event.
  enqueue: (text, options) => enqueueSessionEvent(text, options),
};

let deps: Deps = defaultDeps;

/** Test seam. */
export function setExecExitNoticeBatchDepsForTest(next?: Partial<Deps>): void {
  deps = next ? { ...defaultDeps, ...next } : defaultDeps;
  pending.clear();
}

function targetIdentity(notice: ExecExitNotice): string {
  return JSON.stringify([
    notice.agentId,
    notice.sessionKey,
    notice.target.sessionId,
    notice.target.generation,
  ]);
}

function ownersAborted(notice: ExecExitNotice): boolean {
  return notice.owners?.some((owner) => owner.signal.aborted) === true;
}

function sendNotices(notices: readonly ExecExitNotice[]): SessionEventReceipt | undefined {
  const first = notices[0];
  if (!first) {
    return undefined;
  }
  const owners = [...new Set(notices.flatMap((notice) => notice.owners ?? []))];
  const single = notices.length === 1;
  const ids = notices.map((notice) => notice.id).join(",");
  const last = notices.at(-1)!;
  try {
    const receipt = deps.enqueue(
      notices.map((notice) => notice.text).join("\n"),
      withExecRequestOwners(
        {
          agentId: first.agentId,
          sessionKey: first.sessionKey,
          source: "exec" as const,
          contextKey: `exec:${ids}`,
          deliveryContext: last.deliveryContext,
          sourceTurnId: `exec:${notices.map((notice) => notice.instanceId).join(",")}`,
          expectedTarget: last.target,
        },
        owners,
      ),
    );
    void receipt.settled.then((outcome) => {
      if (outcome.status === "failed") {
        logWarn(`exec: completion delivery failed (${outcome.error}); inspect the process result.`);
      }
    });
    return single ? receipt : undefined;
  } catch (error) {
    logWarn(
      `exec: completion ${ids} was not admitted (${formatErrorMessage(error)}); inspect the process result.`,
    );
    return undefined;
  }
}

function flush(key: string): void {
  const batch = pending.get(key);
  if (!batch) {
    return;
  }
  pending.delete(key);
  const live = batch.notices.filter((notice) => !notice.isObsolete() && !ownersAborted(notice));
  // Notices captured for different generations of one key cannot share a destination.
  const groups = new Map<string, ExecExitNotice[]>();
  for (const notice of live) {
    const identity = targetIdentity(notice);
    groups.set(identity, [...(groups.get(identity) ?? []), notice]);
  }
  for (const notices of groups.values()) {
    sendNotices(notices);
  }
}

function waitAndFlush(key: string, sessionKey: string): void {
  const batch = pending.get(key);
  if (!batch || batch.waiting) {
    return;
  }
  batch.waiting = true;
  void Promise.resolve()
    .then(() => deps.waitForIdle(sessionKey))
    .catch(() => undefined)
    .then(() => {
      const current = pending.get(key);
      if (!current) {
        return;
      }
      current.waiting = false;
      // A follow-up may already hold the lane again; keep collecting until it is idle.
      if (deps.isSessionBusy(sessionKey)) {
        waitAndFlush(key, sessionKey);
        return;
      }
      flush(key);
    });
}

/**
 * Delivers one completion notice now when its session is idle, or holds it until the running
 * turn ends and sends everything collected meanwhile as one event. The returned function drops
 * a held or single queued notice (process poll acknowledgement, process removal).
 */
export function deliverExecExitNotice(notice: ExecExitNotice): () => boolean {
  const key = JSON.stringify([notice.agentId, notice.sessionKey]);
  const batch = pending.get(key);
  if (!batch && !deps.isSessionBusy(notice.sessionKey)) {
    const receipt = sendNotices([notice]);
    return receipt ? receipt.cancel : () => false;
  }
  const current = batch ?? { notices: [], waiting: false };
  current.notices.push(notice);
  pending.set(key, current);
  waitAndFlush(key, notice.sessionKey);
  return () => {
    const held = pending.get(key);
    const index = held?.notices.indexOf(notice) ?? -1;
    if (!held || index < 0) {
      return false;
    }
    held.notices.splice(index, 1);
    return true;
  };
}
