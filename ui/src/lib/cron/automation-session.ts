/**
 * The job behind an isolated automation chat (`agent:<agentId>:cron:<jobId>`, or one of its
 * `:run:<runId>` sessions). Other chats, including main-session automations, have none.
 */
export function automationSessionJobId(sessionKey: string | null | undefined): string | null {
  const match = /^agent:[^:]+:cron:([^:]+)(?::run:[^:]+)?$/i.exec(sessionKey?.trim() ?? "");
  return match?.[1] ?? null;
}
