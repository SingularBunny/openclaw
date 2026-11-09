import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  countRunningAgentTurns,
  resolveRestartAgentRunWait,
} from "../../gateway/restart-agent-run-wait.js";
import {
  trackGatewayRestartDeferral,
  type GatewayRestartNoticeHandle,
} from "../../gateway/restart-notice.js";
import type { GatewayActiveWorkSnapshot } from "../../infra/gateway-active-work.js";
import {
  GATEWAY_SHUTDOWN_RESERVE_MS,
  GATEWAY_SHUTDOWN_TIMEOUT_MS,
} from "../../infra/gateway-shutdown-budget.js";
import type { SubsystemLogger } from "../../logging/subsystem.js";

/**
 * Fork F44: with OPENCLAW_RESTART_AGENT_RUN_WAIT_MS set, a shutdown drain (service stop, SIGTERM,
 * SIGINT, an in-process restart such as an installation replacement) waits for running agent
 * turns up to that bound instead of aborting them when upstream's drain budget runs out.
 *
 * - Other work keeps upstream's budget: once no agent turn runs, the drain ends as upstream's would.
 * - Admission stays closed while it waits (upstream's drain), so the wait converges: new turns get
 *   the restart/stop error and nothing new starts.
 * - The supervisor's stop timeout still bounds it (systemd TimeoutStopSec): the Gateway never waits
 *   past the point where it would be killed.
 * - A second SIGTERM/SIGINT (the first one for a restart drain, which it turns into a stop), or a
 *   SIGQUIT, ends the wait at once; the shutdown then aborts what still runs, as upstream does.
 * - Control UIs get the `gateway.restart` notice with phase `draining` or `stopping`.
 *
 * Unset, invalid or not above upstream's 5 minutes: upstream behaviour.
 */

/** Longest delay Node schedules as given; longer ones fire at once. */
const MAX_TIMER_MS = 2_147_483_647;
const DEFAULT_POLL_MS = 250;
const FORCE_SIGNALS = ["SIGTERM", "SIGINT", "SIGQUIT"] as const;
type ForceSignal = (typeof FORCE_SIGNALS)[number];

/**
 * The Gateway shutdown limit (drain plus cleanup reserve) the fork wait needs, above upstream's
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

/**
 * How long this drain may wait for agent turns, from now; undefined keeps upstream's drain (the
 * wait is off, skipped for this request, or no longer than upstream's own drain).
 */
export function resolveAgentTurnDrainMs(params: {
  budget: { timeoutMs: number; reserveMs: number };
  /** Time since the stop or restart was accepted; the bound counts from there. */
  elapsedMs: number;
  /** Upstream's drain for this request; undefined waits without a timeout already. */
  upstreamDrainMs: number | undefined;
  /** Forced restarts and drains an external owner already did keep upstream's behaviour. */
  skip: boolean;
  env?: NodeJS.ProcessEnv;
}): number | undefined {
  if (params.skip || params.upstreamDrainMs === undefined) {
    return undefined;
  }
  const wait = resolveRestartAgentRunWait(params.env);
  if (!wait) {
    return undefined;
  }
  const remainingMs = Math.min(
    (wait.maxWaitMs ?? Infinity) - params.elapsedMs,
    params.budget.timeoutMs - params.budget.reserveMs,
    MAX_TIMER_MS,
  );
  return remainingMs > params.upstreamDrainMs ? Math.floor(remainingMs) : undefined;
}

/** Agent turns and the reply deliveries that finish them. */
function hasAgentTurnWork(snapshot: GatewayActiveWorkSnapshot): boolean {
  return countRunningAgentTurns(snapshot.counts) + snapshot.counts.pendingReplies > 0;
}

type SignalSource = {
  on(signal: ForceSignal, listener: () => void): unknown;
  removeListener(signal: ForceSignal, listener: () => void): unknown;
};

export type AgentTurnShutdownWait = {
  /**
   * Waits for all active work like waitForGatewayActiveWork. Past `upstreamTimeoutMs` it keeps
   * waiting while agent turns run, until the agent-turn deadline or a forcing signal.
   */
  wait(
    upstreamTimeoutMs: number | undefined,
    onSnapshot?: (snapshot: GatewayActiveWorkSnapshot) => void,
  ): Promise<{ drained: boolean; snapshot: GatewayActiveWorkSnapshot }>;
  readonly forced: boolean;
  /** Removes the signal listeners and ends the notice. */
  finish(): void;
};

export function startAgentTurnShutdownWait(params: {
  action: "stop" | "restart";
  reason: string;
  /** Epoch ms; the wait for agent turns ends here at the latest. */
  deadlineAt: number;
  inspect: () => GatewayActiveWorkSnapshot;
  logger: Pick<SubsystemLogger, "info" | "warn">;
  signals?: SignalSource;
  now?: () => number;
  pollMs?: number;
  noticePollMs?: number;
}): AgentTurnShutdownWait {
  const now = params.now ?? Date.now;
  const pollMs = params.pollMs ?? DEFAULT_POLL_MS;
  const signals = params.signals ?? process;
  let stopping = params.action === "stop";
  let forced = false;
  let finished = false;
  let wake: (() => void) | undefined;
  let notice: GatewayRestartNoticeHandle | null = null;
  const reason = truncateUtf16Safe(params.reason, 240);

  const force = (why: string) => {
    if (forced) {
      return;
    }
    forced = true;
    params.logger.warn(`${why}; no longer waiting for running agent turns`);
    wake?.();
  };
  const listeners = FORCE_SIGNALS.map((signal) => {
    const listener = () => {
      if (finished) {
        return;
      }
      if (signal === "SIGQUIT" || stopping) {
        force(`received ${signal} while waiting`);
        return;
      }
      // The first stop signal during a restart drain turns it into a stop (systemctl restart).
      stopping = true;
      notice?.setPhase("stopping");
      params.logger.info(
        `received ${signal} while a restart waits for agent turns; still waiting (a second SIGTERM/SIGINT or SIGQUIT stops at once)`,
      );
    };
    signals.on(signal, listener);
    return [signal, listener] as const;
  });

  const startNotice = () => {
    if (notice || finished) {
      return;
    }
    const deadlineAt = params.deadlineAt - now() >= MAX_TIMER_MS ? null : params.deadlineAt;
    notice = trackGatewayRestartDeferral({
      reason,
      budgetMs: 0,
      phase: stopping ? "stopping" : "draining",
      deadlineAt,
      getCounts: () => {
        const { counts } = params.inspect();
        return { agentTurns: countRunningAgentTurns(counts), totalActive: counts.totalActive };
      },
      ...(params.noticePollMs ? { pollMs: params.noticePollMs } : {}),
    });
  };

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      if (forced) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        wake = undefined;
        resolve();
      }, ms);
      wake = () => {
        clearTimeout(timer);
        wake = undefined;
        resolve();
      };
    });

  let extended = false;
  return {
    get forced() {
      return forced;
    },
    async wait(upstreamTimeoutMs, onSnapshot) {
      const upstreamDeadlineAt =
        upstreamTimeoutMs === undefined ? undefined : now() + Math.max(0, upstreamTimeoutMs);
      for (;;) {
        const snapshot = params.inspect();
        onSnapshot?.(snapshot);
        if (snapshot.idle || forced) {
          return { drained: snapshot.idle, snapshot };
        }
        if (hasAgentTurnWork(snapshot)) {
          startNotice();
        }
        const at = now();
        let until = upstreamDeadlineAt;
        if (upstreamDeadlineAt !== undefined && at >= upstreamDeadlineAt) {
          if (!hasAgentTurnWork(snapshot) || at >= params.deadlineAt) {
            return { drained: false, snapshot };
          }
          if (!extended) {
            extended = true;
            params.logger.warn(
              `drain budget reached; waiting for ${countRunningAgentTurns(snapshot.counts)} running agent turn(s) up to ${Math.max(0, params.deadlineAt - at)}ms more before ${stopping ? "stop" : "restart"} (OPENCLAW_RESTART_AGENT_RUN_WAIT_MS); a second SIGTERM/SIGINT or SIGQUIT stops at once`,
            );
          }
          until = params.deadlineAt;
        }
        await sleep(until === undefined ? pollMs : Math.max(0, Math.min(pollMs, until - at)));
      }
    },
    finish() {
      if (finished) {
        return;
      }
      finished = true;
      for (const [signal, listener] of listeners) {
        signals.removeListener(signal, listener);
      }
      wake?.();
      // A restart shows "restarting now"; a stop ends with the disconnect.
      if (stopping) {
        notice?.clear();
      } else {
        notice?.restarting();
      }
    },
  };
}
