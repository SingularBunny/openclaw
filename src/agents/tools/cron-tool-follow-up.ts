/**
 * Fork: the follow-up-only automations scope granted by `cron.followUpChainLimit`
 * to a scheduled turn that otherwise has no automations authority (for example
 * a Claude CLI turn on the Gateway loopback surface).
 */
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  readCronRunFollowUpLink,
  recordCronRunFollowUpDepth,
} from "../../cron/follow-up-chain-run.js";
import {
  CRON_FOLLOW_UP_ONLY_MESSAGE,
  decideCronFollowUp,
  resolveCronFollowUpChainLimit,
} from "../../cron/follow-up-chain.js";
import { recordCronNextCheckProposal } from "../../infra/agent-run-registry.js";
import type { CronToolOptions } from "./cron-tool.types.js";

export const CRON_FOLLOW_UP_ONLY_DESCRIPTION =
  'Follow-ups of the current automation only. Action: next_check in:"20m" rearms this one-shot session continuation from run end (minimum 2s) so the next step runs in a later turn; the owner caps how many follow-ups one chain may take. Without next_check the job completes normally. Creating, editing, removing or running jobs is unavailable here. Return the task result; the scheduler owns delivery.';

export function assertCronFollowUpOnlyScope(opts: CronToolOptions | undefined, action: string) {
  if (opts?.followUpOnly && action !== "next_check") {
    throw new Error(CRON_FOLLOW_UP_ONLY_MESSAGE);
  }
}

/**
 * Records a next_check proposal. Under `cron.followUpChainLimit` a one-shot
 * continuation must belong to an owner-started chain below the limit, and the
 * accepted proposal carries the next depth to the rearmed job.
 */
export function proposeCronNextCheck(
  config: OpenClawConfig,
  runId: string,
  jobId: string,
  delayMs: number,
): void {
  const decision = decideCronFollowUp({
    limit: resolveCronFollowUpChainLimit(config),
    link: readCronRunFollowUpLink(runId, jobId),
  });
  if (decision.kind === "denied") {
    throw new Error(decision.message);
  }
  recordCronNextCheckProposal(runId, jobId, delayMs);
  if (decision.kind === "allowed") {
    recordCronRunFollowUpDepth(runId, jobId, decision.nextDepth);
  }
}
