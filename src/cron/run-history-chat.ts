const AUTOMATION_CHAT_KEY = /^agent:[^:]+:cron:([^:]+)$/i;
const RUN_SUFFIX = /:run:[^:]+$/i;

/** The chat a session key belongs to: isolated runs (`…:run:<runId>`) fold into their automation chat. */
export function cronChatSessionKey(sessionKey: string): string {
  return sessionKey.trim().replace(RUN_SUFFIX, "").toLowerCase();
}

/** Jobs whose runs land in this chat: the automation that owns it and jobs targeting it by session. */
export function cronJobsDeliveringToChat(
  sessionKey: string,
  jobs: readonly { id: string; sessionTarget?: string }[],
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
