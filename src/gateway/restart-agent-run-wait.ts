import { resolveGatewayRestartDeferralTimeoutMs } from "../infra/restart-budget.js";

/**
 * Fork: OPENCLAW_RESTART_AGENT_RUN_WAIT_MS lets a restart required by a config change wait for
 * running agent turns instead of aborting them when upstream's deferral budget (5 minutes) runs
 * out. Other work stays bounded by that budget: once no agent turn runs, a deferral past its budget
 * forces the restart as upstream does.
 *
 * - unset, empty, invalid, or not above upstream's budget: upstream behaviour;
 * - a positive integer: the longest total wait, in milliseconds, while agent turns run;
 * - `unlimited`: wait until no agent turn runs.
 *
 * Read on use: each new deferral reads the current value.
 */
export const RESTART_AGENT_RUN_WAIT_ENV = "OPENCLAW_RESTART_AGENT_RUN_WAIT_MS";

export type RestartAgentRunWait = {
  /** Total wait bound while agent turns run; undefined waits until they finish. */
  maxWaitMs: number | undefined;
};

export function resolveRestartAgentRunWait(
  env: NodeJS.ProcessEnv = process.env,
): RestartAgentRunWait | undefined {
  const raw = env[RESTART_AGENT_RUN_WAIT_ENV]?.trim();
  if (!raw) {
    return undefined;
  }
  if (/^unlimited$/i.test(raw)) {
    return { maxWaitMs: undefined };
  }
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > resolveGatewayRestartDeferralTimeoutMs()
    ? { maxWaitMs: value }
    : undefined;
}

type AgentWorkCounts = {
  agentRuns: number;
  embeddedRuns: number;
  acpRuns: number;
  chatRuns: number;
  sessionAdmissions: number;
};

/** Agent turns that a forced restart would abort: admitted, embedded, ACP and chat runs. */
export function countActiveAgentWork(counts: AgentWorkCounts): number {
  return (
    counts.agentRuns +
    counts.embeddedRuns +
    counts.acpRuns +
    counts.chatRuns +
    counts.sessionAdmissions
  );
}
