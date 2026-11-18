import type { CronRunLogEntry } from "./run-log-types.js";
import type { CronJob } from "./types.js";

const AUTOMATION_CHAT_KEY = /^agent:[^:]+:cron:([^:]+)$/i;
const RUN_SUFFIX = /:run:[^:]+$/i;

/** The chat a session key belongs to: isolated runs (`…:run:<runId>`) fold into their automation chat. */
export function cronChatSessionKey(sessionKey: string): string {
  return sessionKey.trim().replace(RUN_SUFFIX, "").toLowerCase();
}

/** Jobs whose runs land in this chat: the automation that owns it and jobs targeting it by session. */
export function cronJobsDeliveringToChat(
  sessionKey: string,
  jobs: readonly Pick<CronJob, "id" | "sessionTarget">[],
): Set<string> {
  const chatKey = cronChatSessionKey(sessionKey);
  const ownerJobId = AUTOMATION_CHAT_KEY.exec(chatKey)?.[1];
  const target = `session:${chatKey}`;
  return new Set(
    jobs
      .filter(
        (job) =>
          job.id.toLowerCase() === ownerJobId ||
          (typeof job.sessionTarget === "string" && job.sessionTarget.toLowerCase() === target),
      )
      .map((job) => job.id),
  );
}

/**
 * Runs that belong to a chat: recorded in it (or in one of its isolated run sessions), or made by a
 * job that delivers into it (covers runs recorded without a session, such as interrupted ones).
 */
export function cronRunBelongsToChat(
  sessionKey: string,
  jobIds: ReadonlySet<string>,
): (entry: Pick<CronRunLogEntry, "jobId" | "sessionKey">) => boolean {
  const chatKey = cronChatSessionKey(sessionKey);
  return (entry) =>
    jobIds.has(entry.jobId) ||
    (typeof entry.sessionKey === "string" && cronChatSessionKey(entry.sessionKey) === chatKey);
}
