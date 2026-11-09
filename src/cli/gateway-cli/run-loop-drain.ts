import {
  markGatewayRestartTrace,
  measureGatewayRestartTrace,
} from "../../gateway/restart-trace.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { GatewayActiveWorkSnapshot } from "../../infra/gateway-active-work.js";
import { formatGatewayDrainCounts } from "../../infra/gateway-drain.js";
import type { SubsystemLogger } from "../../logging/subsystem.js";
import { beginGatewayShutdownCleanup } from "../../process/gateway-work-admission.js";
import { startAgentTurnShutdownWait } from "./run-loop-agent-turn-wait.js";
import type { GatewayRunSignalAction, GatewayRunSignalRequest } from "./run-loop-request.js";
import { formatShutdownReason } from "./run-loop-shutdown-format.js";

const RESTART_DRAIN_STILL_PENDING_WARN_MS = 30_000;

type DrainGatewayActiveWorkParams = {
  request: GatewayRunSignalRequest;
  runtime: typeof import("./lifecycle.runtime.js");
  drainTimeoutMs: number | undefined;
  restartDrainDeadlineAt: number | undefined;
  /** Fork F44: wait for running agent turns until then (run-loop-agent-turn-wait.ts). */
  agentTurnDrainDeadlineAt?: number;
  recordCounts: (counts: string) => void;
  recordWarning: (warning: string) => void;
  logger: Pick<SubsystemLogger, "info" | "warn">;
};

export async function drainGatewayActiveWork(params: DrainGatewayActiveWorkParams) {
  const { request, runtime, agentTurnDrainDeadlineAt, logger } = params;
  const agentTurnWait =
    agentTurnDrainDeadlineAt === undefined
      ? undefined
      : startAgentTurnShutdownWait({
          action: request.action === "stop" ? "stop" : "restart",
          reason: formatShutdownReason(request),
          deadlineAt: agentTurnDrainDeadlineAt,
          inspect: () => runtime.createGatewayActiveWorkSnapshot(),
          logger,
        });
  try {
    return await drainActiveWork(params, (timeoutMs, onSnapshot) =>
      agentTurnWait
        ? agentTurnWait.wait(timeoutMs, onSnapshot)
        : runtime.waitForGatewayActiveWork(timeoutMs, { onSnapshot }),
    );
  } finally {
    agentTurnWait?.finish();
  }
}

async function drainActiveWork(
  {
    request,
    runtime,
    drainTimeoutMs,
    restartDrainDeadlineAt,
    recordCounts,
    recordWarning,
    logger,
  }: DrainGatewayActiveWorkParams,
  waitForActiveWork: (
    timeoutMs: number | undefined,
    onSnapshot: (snapshot: GatewayActiveWorkSnapshot) => void,
  ) => Promise<{ drained: boolean; snapshot: GatewayActiveWorkSnapshot }>,
) {
  const { restartIntent } = request;
  let drainTimedOut = false;
  const reportDrainSnapshot = createGatewayDrainReporter(
    request.action,
    drainTimeoutMs,
    runtime,
    logger,
    recordCounts,
  );
  // On restart, wait for the canonical process activity inventory before
  // tearing down the server so active work can settle.
  if (request.action !== "stop") {
    let activeWorkAtDrainStart = 0;
    let activeRunsAtDrainStart = 0;
    await measureGatewayRestartTrace(
      "restart.drain",
      async () => {
        const { abortEmbeddedAgentRun, createGatewayActiveWorkSnapshot } = runtime;
        // Reject new enqueues immediately during the drain window so
        // sessions get an explicit restart error instead of silent task loss.
        const drainReason = formatShutdownReason(request);
        runtime.markGatewayDraining(drainReason);
        const initialSnapshot = createGatewayActiveWorkSnapshot();
        activeWorkAtDrainStart = initialSnapshot.counts.totalActive;
        activeRunsAtDrainStart = initialSnapshot.counts.embeddedRuns;
        if (activeRunsAtDrainStart > 0) {
          abortEmbeddedAgentRun(undefined, { mode: "compacting", reason: "restart" });
        }

        reportDrainSnapshot(initialSnapshot);
        if (request.interruptAfterDrain) {
          logger.info("external restart owner already drained; interrupting remaining work");
          runtime.abortActiveCronTaskRuns();
          return;
        }
        const remainingDrainTimeoutMs =
          restartDrainDeadlineAt === undefined
            ? undefined
            : Math.max(0, restartDrainDeadlineAt - Date.now());
        const drain = await waitForActiveWork(remainingDrainTimeoutMs, reportDrainSnapshot);
        if (drain.drained) {
          if (!initialSnapshot.idle) {
            logger.info("all active work drained");
          }
          return;
        }
        drainTimedOut = true;
        const warning = `restart drain budget ${drainTimeoutMs}ms exhausted; cutting short ${formatGatewayDrainCounts(drain.snapshot)}`;
        recordWarning(warning);
        logger.warn(warning);
        // Connection work can retain cron cleanup; cancel before close joins it.
        runtime.abortActiveCronTaskRuns();
      },
      () => [
        ["activeWork", activeWorkAtDrainStart],
        ["activeRuns", activeRunsAtDrainStart],
        ["timedOut", drainTimedOut],
        ["force", restartIntent?.force === true],
      ],
    );
  } else {
    // Keep all process-owned work alive without spending the shutdown reserve
    // that server teardown and the supervisor watchdog need.
    try {
      markGatewayRestartTrace("stop.drain.begin");
      const activeWorkDrain = await measureGatewayRestartTrace("stop.drain", () =>
        waitForActiveWork(drainTimeoutMs, reportDrainSnapshot),
      );
      if (!activeWorkDrain.drained) {
        drainTimedOut = true;
        logger.warn(
          `gateway active-work drain timeout reached; proceeding with shutdown: ${formatGatewayDrainCounts(activeWorkDrain.snapshot)}`,
        );
        runtime.abortEmbeddedAgentRun(undefined, { mode: "all" });
        runtime.abortActiveCronTaskRuns("Gateway stopping.");
      }
    } catch (err) {
      logger.warn(
        `gateway active-work drain failed; proceeding with shutdown: ${formatErrorMessage(err)}`,
      );
    }
    logger.info("active-work drain settled; beginning server close");
  }
  beginGatewayShutdownCleanup();
  return drainTimedOut;
}

function createGatewayDrainReporter(
  action: GatewayRunSignalAction,
  drainTimeoutMs: number | undefined,
  runtime: Pick<
    typeof import("./lifecycle.runtime.js"),
    "listActiveEmbeddedRunSessionIds" | "getDiagnosticSessionActivitySnapshot"
  >,
  logger: Pick<SubsystemLogger, "info" | "warn">,
  recordCounts: (counts: string) => void,
) {
  const drainBudget =
    drainTimeoutMs === undefined ? "without a timeout" : `with timeout ${drainTimeoutMs}ms`;
  let lastPendingWarningAt: number | undefined;
  return (snapshot: GatewayActiveWorkSnapshot) => {
    recordCounts(
      `${formatGatewayDrainCounts(snapshot) || "no active work"}; pending owners: ${
        snapshot.blockers.map(({ message }) => message).join("; ") || "none"
      }`,
    );
    const now = Date.now();
    if (lastPendingWarningAt === undefined) {
      lastPendingWarningAt = now;
      if (!snapshot.idle) {
        logger.info(
          `draining active work before ${action} ${drainBudget}: ${formatGatewayDrainCounts(snapshot)}`,
        );
        const requestTimeoutMs = Math.max(
          0,
          ...runtime
            .listActiveEmbeddedRunSessionIds()
            .map(
              (sessionId) =>
                runtime.getDiagnosticSessionActivitySnapshot({ sessionId })
                  ?.activeModelCallRequestTimeoutMs ?? 0,
            ),
        );
        if (requestTimeoutMs > 0) {
          logger.info(
            `largest observed model request timeout is ${requestTimeoutMs}ms; shutdown drain budget remains ${drainBudget}`,
          );
        }
      }
    } else if (
      !snapshot.idle &&
      now - lastPendingWarningAt >= RESTART_DRAIN_STILL_PENDING_WARN_MS
    ) {
      lastPendingWarningAt = now;
      logger.warn(
        `still draining active work before ${action}: ${formatGatewayDrainCounts(snapshot)}`,
      );
    }
  };
}
