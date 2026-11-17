/**
 * Fork: `cron.followUpChainLimit` caps how many times an owner-created one-shot
 * continuation may rearm itself through `next_check`. Upstream 2026.11.5 gives
 * scheduled turns (embedded and the Gateway loopback a CLI backend uses) the
 * self-scoped automations tool; this only adds the chain depth check.
 */
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  readCronRunFollowUpLink,
  recordCronRunFollowUpDepth,
} from "../../cron/follow-up-chain-run.js";
import { decideCronFollowUp, resolveCronFollowUpChainLimit } from "../../cron/follow-up-chain.js";
import { recordCronNextCheckProposal } from "../../infra/agent-run-registry.automation.js";

/**
 * Records a next_check proposal. Under `cron.followUpChainLimit` a one-shot
 * continuation must belong to an owner-started chain below the limit, and the
 * accepted proposal carries the next depth to the rearmed job.
 */
export function proposeCronNextCheck(
  config: OpenClawConfig | undefined,
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
