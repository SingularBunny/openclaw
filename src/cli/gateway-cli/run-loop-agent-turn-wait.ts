import { performance } from "node:perf_hooks";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  countRunningAgentTurns,
  resolveRestartAgentRunWait,
} from "../../gateway/restart-agent-run-wait.js";
import type { GatewayRestartNoticeHandle } from "../../gateway/restart-notice.js";
import type { GatewayActiveWorkSnapshot } from "../../infra/gateway-active-work.js";
import {
  GATEWAY_SHUTDOWN_RESERVE_MS,
  GATEWAY_SHUTDOWN_TIMEOUT_MS,
} from "../../infra/gateway-shutdown-budget.js";
import type { SubsystemLogger } from "../../logging/subsystem.js";
import type { GatewayRunSignalRequest } from "./run-loop-request.js";

/**
 * Fork F44: with OPENCLAW_RESTART_AGENT_RUN_WAIT_MS set, a stop (service stop, SIGTERM, SIGINT)
 * and an in-process restart (installation replaced, service refresh) wait for running agent turns
 * before the Gateway closes, instead of persisting and aborting them at once.
 *
 * Upstream 2026.11.5 closes right after `markGatewayDraining`: the close plan records running
 * sessions for restart recovery and cancels them. The wait sits between the two, so it reuses
 * upstream's admission fence (new turns get the restart/stop error while it waits) and upstream's
 * active-work inventory (session-controller runs, admitted agent runs, ACP and chat runs, reply
 * deliveries).
 *
 * - The bound counts from the accepted stop or restart; the shutdown deadline (systemd
 *   TimeoutStopSec, see resolveAgentTurnShutdownLimitMs) still caps it and keeps the cleanup
 *   reserve.
 * - A second SIGTERM/SIGINT (the first one for a restart, which upstream turns into a stop), or a
 *   SIGQUIT, ends the wait at once; the close then aborts what still runs, as upstream does.
 * - Control UIs get the `gateway.restart` notice with phase `draining` or `stopping`.
 * - Forced restarts, suspend handoffs, fresh-process restarts and managed update handoffs keep
 *   upstream's immediate close.
 *
 * Unset, invalid or not above upstream's 5 minutes: upstream behaviour.
 */

/** Longest delay Node schedules as given; longer ones fire at once. */
const MAX_TIMER_MS = 2_147_483_647;
const DEFAULT_POLL_MS = 250;
const STILL_WAITING_LOG_MS = 60_000;
const FORCE_SIGNALS = ["SIGTERM", "SIGINT", "SIGQUIT"] as const;
type ForceSignal = (typeof FORCE_SIGNALS)[number];

/**
 * The Gateway shutdown limit (wait plus cleanup reserve) the fork wait needs, above upstream's
 * fixed limit; undefined when the wait is off. The supervisor's stop timeout still caps it.
 */
export function resolveAgentTurnShutdownLimitMs(
  env: NodeJS.ProcessEnv = process.env,
): number | undefined {
  const wait = resolveRestartAgentRunWait(env);
  if (!wait) {
    return undefined;
  }
  return wait.maxWaitMs === undefined
    ? MAX_TIMER_MS
    : Math.min(
        MAX_TIMER_MS,
        Math.max(GATEWAY_SHUTDOWN_TIMEOUT_MS, wait.maxWaitMs + GATEWAY_SHUTDOWN_RESERVE_MS),
      );
}

/** Requests that keep upstream's immediate close. */
function skipsAgentTurnWait(request: AgentTurnWaitRequest): boolean {
  const intent = request.restartIntent;
  return (
    request.action === "external-restart" ||
    intent?.force === true ||
    intent?.requireFreshProcess === true ||
    intent?.successorOwner !== undefined ||
    request.foregroundUpdate === true
  );
}

/** Agent turns and the reply deliveries that finish them. */
function countAgentTurnWork(snapshot: GatewayActiveWorkSnapshot): number {
  return countRunningAgentTurns(snapshot.counts) + snapshot.counts.pendingReplies;
}

const AGENT_TURN_BLOCKERS = new Set(["embedded-run", "agent-run", "acp-run", "chat-run", "reply"]);

type SignalSource = {
  on(signal: ForceSignal, listener: () => void): unknown;
  removeListener(signal: ForceSignal, listener: () => void): unknown;
};

type AgentTurnWaitRequest = Pick<
  GatewayRunSignalRequest,
  "action" | "acceptedAtMs" | "restartIntent" | "foregroundUpdate"
>;

export type AgentTurnWaitOutcome = "off" | "idle" | "timeout" | "forced";

/**
 * Waits for running agent turns before the shutdown closes the Gateway. Call it after admission
 * is closed (`markGatewayDraining`). `shutdownDeadline` is the performance.now() time at which the
 * shutdown is force-exited; the wait ends `reserveMs` before it.
 */
export async function waitForAgentTurnsBeforeShutdown(params: {
  request: AgentTurnWaitRequest;
  reason: string;
  shutdownDeadline: number | undefined;
  reserveMs: number;
  logger: Pick<SubsystemLogger, "info" | "warn">;
  env?: NodeJS.ProcessEnv;
  inspect?: () => GatewayActiveWorkSnapshot;
  listSessions?: () => string[];
  trackNotice?: typeof import("../../gateway/restart-notice.js").trackGatewayRestartDeferral;
  signals?: SignalSource;
  /** performance.now() clock; the notice uses Date.now(). */
  now?: () => number;
  pollMs?: number;
  noticePollMs?: number;
}): Promise<AgentTurnWaitOutcome> {
  const wait = resolveRestartAgentRunWait(params.env);
  if (!wait || skipsAgentTurnWait(params.request)) {
    return "off";
  }
  const now = params.now ?? (() => performance.now());
  const startedAt = now();
  const waitUntil = Math.min(
    wait.maxWaitMs === undefined ? Infinity : params.request.acceptedAtMs + wait.maxWaitMs,
    params.shutdownDeadline === undefined
      ? Infinity
      : params.shutdownDeadline - Math.max(0, params.reserveMs),
    startedAt + MAX_TIMER_MS,
  );
  const inspect =
    params.inspect ??
    (await import("../../infra/gateway-active-work.js")).createGatewayActiveWorkSnapshot;
  let snapshot = inspect();
  if (countAgentTurnWork(snapshot) === 0 || waitUntil <= startedAt) {
    return "idle";
  }
  const listSessions =
    params.listSessions ??
    (await import("../../sessions/session-controller.queries.js")).listActiveSessionRunKeys;
  const trackNotice =
    params.trackNotice ??
    (await import("../../gateway/restart-notice.js")).trackGatewayRestartDeferral;
  const signals = params.signals ?? process;
  const pollMs = params.pollMs ?? DEFAULT_POLL_MS;
  const { logger } = params;
  let stopping = params.request.action === "stop";
  let forced = false;
  let wake: (() => void) | undefined;

  const describe = () => {
    const blockers = snapshot.blockers
      .filter((blocker) => AGENT_TURN_BLOCKERS.has(blocker.kind))
      .map((blocker) => blocker.message);
    let sessions: string[] = [];
    try {
      sessions = listSessions();
    } catch {
      // Session keys are diagnostics only.
    }
    return `${countRunningAgentTurns(snapshot.counts)} running agent turn(s)${
      blockers.length ? ` (${blockers.join("; ")})` : ""
    }${sessions.length ? `; sessions: ${sessions.slice(0, 8).join(", ")}` : ""}`;
  };
  const notice: GatewayRestartNoticeHandle = trackNotice({
    reason: truncateUtf16Safe(params.reason, 240),
    budgetMs: 0,
    phase: stopping ? "stopping" : "draining",
    deadlineAt: waitUntil - startedAt >= MAX_TIMER_MS ? null : Date.now() + (waitUntil - startedAt),
    getCounts: () => {
      const { counts } = inspect();
      return { agentTurns: countRunningAgentTurns(counts), totalActive: counts.totalActive };
    },
    ...(params.noticePollMs ? { pollMs: params.noticePollMs } : {}),
  });
  const listeners = FORCE_SIGNALS.map((signal) => {
    const listener = () => {
      if (forced) {
        return;
      }
      if (signal === "SIGQUIT" || stopping) {
        forced = true;
        logger.warn(`received ${signal} while waiting; no longer waiting for running agent turns`);
        wake?.();
        return;
      }
      // The first stop signal during a restart turns it into a stop (systemctl restart).
      stopping = true;
      notice.setPhase("stopping");
      logger.info(
        `received ${signal} while a restart waits for agent turns; still waiting (a second SIGTERM/SIGINT or SIGQUIT stops at once)`,
      );
    };
    signals.on(signal, listener);
    return [signal, listener] as const;
  });
  logger.warn(
    `waiting up to ${Math.round(waitUntil - startedAt)}ms for ${describe()} before ${stopping ? "stop" : "restart"} (OPENCLAW_RESTART_AGENT_RUN_WAIT_MS); new turns are refused; a second SIGTERM/SIGINT or SIGQUIT stops at once`,
  );
  let nextLogAt = startedAt + STILL_WAITING_LOG_MS;
  let outcome: AgentTurnWaitOutcome;
  try {
    for (;;) {
      const at = now();
      if (forced) {
        outcome = "forced";
        break;
      }
      if (at >= waitUntil) {
        outcome = "timeout";
        logger.warn(
          `agent-turn wait ran out after ${Math.round(at - startedAt)}ms; ${stopping ? "stopping" : "restarting"} with ${describe()}`,
        );
        break;
      }
      if (at >= nextLogAt) {
        nextLogAt = at + STILL_WAITING_LOG_MS;
        logger.info(`still waiting for ${describe()}`);
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(
          () => {
            wake = undefined;
            resolve();
          },
          Math.max(0, Math.min(pollMs, waitUntil - at)),
        );
        wake = () => {
          clearTimeout(timer);
          wake = undefined;
          resolve();
        };
      });
      if (forced) {
        continue;
      }
      snapshot = inspect();
      if (countAgentTurnWork(snapshot) === 0) {
        outcome = "idle";
        logger.info(
          `running agent turns finished after ${Math.round(now() - startedAt)}ms; continuing ${stopping ? "stop" : "restart"}`,
        );
        break;
      }
    }
  } finally {
    for (const [signal, listener] of listeners) {
      signals.removeListener(signal, listener);
    }
    // A restart shows "restarting now"; a stop ends with the disconnect.
    if (stopping) {
      notice.clear();
    } else {
      notice.restarting();
    }
  }
  return outcome;
}
