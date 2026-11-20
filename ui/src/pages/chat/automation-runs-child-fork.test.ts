import { describe, expect, it } from "vitest";
import type { CronJob, CronRunLogEntry } from "../../api/types.ts";
import { loadChildJobRuns, mergeRuns } from "./automation-runs-child-fork.ts";

const run = (jobId: string, at: number) => ({ jobId, ts: at, runAtMs: at }) as CronRunLogEntry;

describe("runs of jobs set up from an automation chat", () => {
  it("reads the latest runs of every job but the owner, and skips one that fails", async () => {
    const calls: unknown[] = [];
    const client = {
      request: async <T>(_method: string, params: Record<string, unknown>) => {
        calls.push(params);
        if (params.id === "broken") {
          throw new Error("gone");
        }
        return { entries: [run(String(params.id), 5)] } as T;
      },
    };
    const jobs = [{ id: "owner" }, { id: "watcher" }, { id: "broken" }] as CronJob[];
    const runs = await loadChildJobRuns(client, jobs, "owner");
    expect(runs.map((entry) => entry.jobId)).toEqual(["watcher"]);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ scope: "job", id: "watcher", sortDir: "desc" });
  });

  it("lists owner and child runs together, newest first", () => {
    const merged = mergeRuns([run("owner", 30), run("owner", 10)], [run("watcher", 20)]);
    expect(merged.map((entry) => `${entry.jobId}@${entry.ts}`)).toEqual([
      "owner@30",
      "watcher@20",
      "owner@10",
    ]);
    const own = [run("owner", 1)];
    expect(mergeRuns(own, [])).toEqual(own);
  });
});
