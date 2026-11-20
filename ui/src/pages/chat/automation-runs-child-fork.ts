// Fork: the Runs tab of an automation chat also lists the latest runs of jobs set up from that chat (a watcher an
// agent scheduled there; `sessionTarget: "current"` with this chat's key). Their run sessions are not chats of their
// own, so this is where their history shows; the owner's runs keep the paging, these add the newest of each job.
import type { CronJob, CronRunLogEntry, CronRunsResult } from "../../api/types.ts";

export const CHILD_JOB_RUNS = 10;

type Client = { request<T>(method: string, params: Record<string, unknown>): Promise<T> };

/** The latest runs of each job but the owner; a job whose history cannot be read is left out. */
export async function loadChildJobRuns(
  client: Client,
  jobs: readonly CronJob[],
  ownerJobId: string | null,
): Promise<CronRunLogEntry[]> {
  const pages = await Promise.all(
    jobs
      .filter((job) => job.id !== ownerJobId)
      .map((job) =>
        client
          .request<CronRunsResult>("cron.runs", {
            view: "summary",
            scope: "job",
            id: job.id,
            limit: CHILD_JOB_RUNS,
            sortDir: "desc",
          })
          .then((page) => page.entries)
          .catch(() => []),
      ),
  );
  return pages.flat();
}

/** Owner runs and child runs in one list, newest first. */
export function mergeRuns(
  own: readonly CronRunLogEntry[],
  children: readonly CronRunLogEntry[],
): CronRunLogEntry[] {
  if (children.length === 0) {
    return [...own];
  }
  const at = (entry: CronRunLogEntry) => entry.runAtMs ?? entry.ts ?? 0;
  return [...own, ...children].toSorted((a, b) => at(b) - at(a));
}
