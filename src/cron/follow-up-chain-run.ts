/**
 * Fork: run-registry side of follow-up chains (see follow-up-chain.ts). The
 * admitted cron run records its chain link; next_check reads it, and the
 * finished run hands the accepted depth to the scheduler with its proposal.
 */
import { getAgentRunContext } from "../infra/agent-run-registry.js";
import type { CronFollowUpChainLink } from "./follow-up-chain.js";

function readCronRun(runId: string | undefined, jobId: string) {
  const id = runId?.trim();
  return id ? getAgentRunContext(id)?.cronRunsByJobId?.get(jobId) : undefined;
}

export function readCronRunFollowUpLink(
  runId: string | undefined,
  jobId: string,
): CronFollowUpChainLink | undefined {
  return readCronRun(runId, jobId)?.followUp;
}

/** Called right after the proposal is recorded on the same live run. */
export function recordCronRunFollowUpDepth(runId: string, jobId: string, depth: number): void {
  const cronRun = readCronRun(runId, jobId);
  if (cronRun) {
    cronRun.nextCheckFollowUpDepth = depth;
  }
}

/** Read before the proposal is consumed; consuming removes the run entry. */
export function readCronRunNextCheckFollowUpDepth(
  runId: string,
  jobId: string,
): number | undefined {
  return readCronRun(runId, jobId)?.nextCheckFollowUpDepth;
}
