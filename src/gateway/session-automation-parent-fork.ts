// Fork: a job set up from a chat (`sessionTarget: "current"` with the chat's `sessionKey`, e.g. a watcher an agent
// schedules while working in that chat) runs under its own `cron:<jobId>` key but reports to the chat it came
// from. That run session is not a chat of its own: its row carries `automationParentKey`, the sidebar leaves it
// out, and its runs are listed in the parent chat's Runs tab. Jobs the owner sets up in Automations have no parent.
import type { CronJob } from "../cron/types.js";
import { normalizeAgentId } from "../routing/session-key.js";

let memo: {
  jobs: readonly CronJob[];
  defaultAgentId?: string;
  parents: ReadonlyMap<string, string>;
} | null = null;

function buildParents(
  jobs: readonly CronJob[],
  defaultAgentId?: string,
): ReadonlyMap<string, string> {
  const parents = new Map<string, string>();
  for (const job of jobs) {
    const parent = typeof job.sessionKey === "string" ? job.sessionKey.trim() : "";
    const agentId = job.owner?.agentId ?? defaultAgentId;
    if (job.sessionTarget !== "current" || !parent || !agentId) {
      continue;
    }
    const runKey = `agent:${normalizeAgentId(agentId)}:cron:${job.id}`.toLowerCase();
    if (runKey !== parent.toLowerCase()) {
      parents.set(runKey, parent);
    }
  }
  return parents;
}

/** The chat a job's run session reports to, when the job was set up from a chat; undefined otherwise. */
export function sessionAutomationParentKey(
  sessionKey: string,
  source: { jobs: readonly CronJob[] | undefined; defaultAgentId: string | undefined },
): string | undefined {
  if (!source.jobs) {
    return undefined;
  }
  if (!memo || memo.jobs !== source.jobs || memo.defaultAgentId !== source.defaultAgentId) {
    memo = {
      jobs: source.jobs,
      defaultAgentId: source.defaultAgentId,
      parents: buildParents(source.jobs, source.defaultAgentId),
    };
  }
  return memo.parents.get(sessionKey.trim().toLowerCase());
}
