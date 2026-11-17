/**
 * Fork: `cron.followUpChainLimit` on the Gateway tool surface. A CLI backend
 * turn started by an owner-created one-shot continuation gets a follow-up-only
 * automations tool scoped to that job; every other non-owner turn keeps the
 * owner-only denial. With the limit at 0 nothing changes.
 */
import { AUTOMATIONS_TOOL_NAME } from "../agents/tools/automations-tool-name.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveCronRunFollowUpJobId } from "../cron/follow-up-chain-run.js";
import { resolveCronFollowUpChainLimit } from "../cron/follow-up-chain.js";

export type GatewayCronFollowUpGrant = {
  cronSelfRemoveOnlyJobId: string;
  cronFollowUpOnly: true;
};

export function resolveGatewayCronFollowUpGrant(params: {
  cfg: OpenClawConfig;
  surface: "http" | "loopback";
  senderIsOwner?: boolean;
  runId?: string;
}): GatewayCronFollowUpGrant | undefined {
  if (
    params.surface !== "loopback" ||
    params.senderIsOwner === true ||
    resolveCronFollowUpChainLimit(params.cfg) <= 0
  ) {
    return undefined;
  }
  const jobId = resolveCronRunFollowUpJobId(params.runId);
  return jobId ? { cronSelfRemoveOnlyJobId: jobId, cronFollowUpOnly: true } : undefined;
}

/** Lifts only the automations owner-only denial, and only for a granted run. */
export function liftFollowUpAutomationsDeny(
  deny: string[],
  grant: GatewayCronFollowUpGrant | undefined,
): string[] {
  return grant ? deny.filter((name) => name !== AUTOMATIONS_TOOL_NAME) : deny;
}
