import type { GatewayRestartNotice } from "../../packages/gateway-protocol/src/index.js";

/**
 * Fork: the state of a Gateway restart that waits for running work (a config change that needs a
 * restart, deferred until agent turns and other work finish; F44: a restart or stop that drains
 * running agent turns, run-loop-agent-turn-wait.ts). Control UIs show it as a notice
 * outside the chat: `gateway.restart` events while it changes, and `snapshot.gatewayRestart` in
 * hello for clients that connect while it is pending. The notice lives in this process only: the
 * restarted Gateway starts without one.
 */
export const GATEWAY_EVENT_RESTART = "gateway.restart" as const;

export type GatewayRestartNoticeEventPayload = { notice: GatewayRestartNotice | null };

export type GatewayRestartNoticeCounts = {
  /** Running agent turns: admitted, embedded, ACP and chat runs. */
  agentTurns: number;
  /** Everything the deferral waits for, agent turns included. */
  totalActive: number;
};

/** Phases a waiting restart or stop publishes until it is over. */
export type GatewayRestartWaitPhase = Exclude<GatewayRestartNotice["phase"], "restarting">;

export type GatewayRestartNoticeHandle = {
  /** Fork F44: the wait changed its nature, e.g. a restart drain that a SIGTERM turned into a stop. */
  setPhase(phase: GatewayRestartWaitPhase): void;
  /** The restart is about to happen (work finished or the wait timed out). */
  restarting(): void;
  /** The restart no longer waits (superseded or cancelled). */
  clear(): void;
};

const DEFAULT_POLL_MS = 5_000;
/** A "restarting" notice whose restart never came (coalesced, failed emission) does not stay. */
const RESTARTING_STALE_MS = 120_000;

let current: GatewayRestartNotice | null = null;
let owner: object | null = null;
let broadcaster: ((payload: GatewayRestartNoticeEventPayload) => void) | null = null;

export function setGatewayRestartNoticeBroadcaster(
  fn: ((payload: GatewayRestartNoticeEventPayload) => void) | null,
): void {
  broadcaster = fn;
}

export function getGatewayRestartNotice(): GatewayRestartNotice | null {
  return current;
}

function publish(next: GatewayRestartNotice | null): void {
  current = next;
  try {
    broadcaster?.({ notice: next });
  } catch {
    // A notice is advisory; the restart itself never depends on it.
  }
}

/**
 * Publishes a pending restart and keeps its waiting counts current until the restart happens or
 * the request is superseded. `agentRunWaitMs`: undefined when the fork's
 * OPENCLAW_RESTART_AGENT_RUN_WAIT_MS is unset (upstream budget only), null for `unlimited`.
 */
export function trackGatewayRestartDeferral(params: {
  reason: string;
  budgetMs: number;
  agentRunWaitMs?: number | null;
  getCounts: () => GatewayRestartNoticeCounts;
  /** F44: a shutdown drain publishes `draining` or `stopping` instead of `pending`. */
  phase?: GatewayRestartWaitPhase;
  /** F44: the drain's own deadline instead of one computed from the budgets. */
  deadlineAt?: number | null;
  now?: () => number;
  pollMs?: number;
}): GatewayRestartNoticeHandle {
  const now = params.now ?? Date.now;
  const since = now();
  let waitPhase: GatewayRestartWaitPhase = params.phase ?? "pending";
  const deadlineAt =
    params.deadlineAt !== undefined
      ? params.deadlineAt
      : params.agentRunWaitMs === null
        ? null
        : since + Math.max(params.budgetMs, params.agentRunWaitMs ?? params.budgetMs);
  const token = {};
  owner = token;
  let timer: ReturnType<typeof setInterval> | null = null;
  let staleTimer: ReturnType<typeof setTimeout> | null = null;
  const readCounts = (): GatewayRestartNoticeCounts => {
    try {
      const counts = params.getCounts();
      return {
        agentTurns: Math.max(0, Math.floor(counts.agentTurns) || 0),
        totalActive: Math.max(0, Math.floor(counts.totalActive) || 0),
      };
    } catch {
      return { agentTurns: current?.activeTurns ?? 0, totalActive: current?.activeWork ?? 0 };
    }
  };
  const build = (phase: GatewayRestartNotice["phase"]): GatewayRestartNotice => {
    const counts = readCounts();
    return {
      phase,
      reason: params.reason,
      since,
      deadlineAt,
      activeTurns: counts.agentTurns,
      activeWork: counts.totalActive,
    };
  };
  const stopTimers = () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (staleTimer) {
      clearTimeout(staleTimer);
      staleTimer = null;
    }
  };
  const isOwner = () => owner === token;
  publish(build(waitPhase));
  timer = setInterval(() => {
    if (!isOwner()) {
      stopTimers();
      return;
    }
    const next = build(waitPhase);
    if (
      current?.phase !== waitPhase ||
      next.activeTurns !== current.activeTurns ||
      next.activeWork !== current.activeWork
    ) {
      publish(next);
    }
  }, params.pollMs ?? DEFAULT_POLL_MS);
  timer.unref?.();
  return {
    setPhase(phase) {
      if (!isOwner() || !timer || phase === waitPhase) {
        return;
      }
      waitPhase = phase;
      publish(build(waitPhase));
    },
    restarting() {
      if (!isOwner()) {
        return;
      }
      stopTimers();
      publish(build("restarting"));
      staleTimer = setTimeout(() => {
        if (isOwner()) {
          owner = null;
          publish(null);
        }
      }, RESTARTING_STALE_MS);
      staleTimer.unref?.();
    },
    clear() {
      stopTimers();
      if (isOwner()) {
        owner = null;
        publish(null);
      }
    },
  };
}

/** Test helper: forget the process-wide notice. */
export function resetGatewayRestartNoticeForTest(): void {
  owner = null;
  current = null;
  broadcaster = null;
}
