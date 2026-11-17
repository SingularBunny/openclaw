/**
 * Fork: owner-approved follow-up chains for one-shot session continuations.
 *
 * `cron.followUpChainLimit` (default 0) lets a turn started by an automation
 * rearm its own one-shot job through `next_check` up to N times. The chain
 * starts at a job the owner created (depth 0); each accepted follow-up stores
 * the next depth on the job state. With the limit at 0 nothing here applies.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isCronOneShotContinuationJob } from "./service/one-shot-schedule.js";
import type { CronStoredJob } from "./types.js";

/** Upper bound of the setting; the schema enforces the same range. */
export const CRON_FOLLOW_UP_CHAIN_LIMIT_MAX = 50;

/** One running link of a follow-up chain, captured when its run is admitted. */
export type CronFollowUpChainLink = {
  /** Follow-ups already taken before this run (the owner-created job is 0). */
  depth: number;
  /** The chain starts at a job the owner created in a turn they started. */
  ownerOrigin: boolean;
};

export type CronFollowUpDecision =
  | { kind: "unchanged" }
  | { kind: "allowed"; nextDepth: number }
  | { kind: "denied"; message: string };

export function resolveCronFollowUpChainLimit(cfg: OpenClawConfig | undefined): number {
  const raw = cfg?.cron?.followUpChainLimit;
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw <= 0) {
    return 0;
  }
  return Math.min(raw, CRON_FOLLOW_UP_CHAIN_LIMIT_MAX);
}

export function readCronFollowUpDepth(job: Pick<CronStoredJob, "state">): number {
  const depth = job.state?.followUpDepth;
  return typeof depth === "number" && Number.isSafeInteger(depth) && depth > 0 ? depth : 0;
}

/**
 * Owner origin: the trusted creation seam captured a local or channel caller
 * with no non-owner channel requester grant, and no agent created the job.
 * Upstream keeps job creation owner-only (scheduled turns get a self-scoped
 * tool without `add`), so these facts identify an owner-created job.
 */
export function isCronFollowUpChainOwnerOrigin(
  job: Pick<CronStoredJob, "createdActor" | "toolsAllowProvenance">,
): boolean {
  const provenance = job.toolsAllowProvenance;
  if (!provenance || provenance.channelRequester || job.createdActor?.type === "agent") {
    return false;
  }
  const origin = provenance.callerOrigin?.kind;
  return origin === "local" || origin === "external";
}

/** Chain facts for a one-shot session continuation; other jobs are outside any chain. */
export function describeCronFollowUpChainLink(
  job: Pick<
    CronStoredJob,
    "schedule" | "payload" | "sessionTarget" | "state" | "createdActor" | "toolsAllowProvenance"
  >,
): CronFollowUpChainLink | undefined {
  if (!isCronOneShotContinuationJob(job)) {
    return undefined;
  }
  return { depth: readCronFollowUpDepth(job), ownerOrigin: isCronFollowUpChainOwnerOrigin(job) };
}

/** Spread into a cron run registry entry; empty outside one-shot continuations. */
export function withCronFollowUpLink(job: Parameters<typeof describeCronFollowUpChainLink>[0]): {
  followUp?: CronFollowUpChainLink;
} {
  const followUp = describeCronFollowUpChainLink(job);
  return followUp ? { followUp } : {};
}

export function formatCronFollowUpLimitReached(limit: number): string {
  return `Follow-up limit ${limit} reached for this automation chain; ask the owner. Do not retry next_check.`;
}

export const CRON_FOLLOW_UP_NOT_OWNER_ORIGIN =
  "This automation chain was not started by a job the owner created, so it cannot schedule follow-ups; ask the owner. Do not retry next_check.";

export const CRON_FOLLOW_UP_ONLY_MESSAGE =
  'automations needs the owner\'s authority, and this turn was not started by the owner. Only next_check in:"<duration>" (a follow-up of this automation) is available here. Do not retry other automations actions.';

/** Applies the limit to one next_check of a one-shot continuation. */
export function decideCronFollowUp(params: {
  limit: number;
  link: CronFollowUpChainLink | undefined;
}): CronFollowUpDecision {
  if (params.limit <= 0 || !params.link) {
    return { kind: "unchanged" };
  }
  if (!params.link.ownerOrigin) {
    return { kind: "denied", message: CRON_FOLLOW_UP_NOT_OWNER_ORIGIN };
  }
  if (params.link.depth >= params.limit) {
    return { kind: "denied", message: formatCronFollowUpLimitReached(params.limit) };
  }
  return { kind: "allowed", nextDepth: params.link.depth + 1 };
}
