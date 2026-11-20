import type { CronRunLogEntry } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { createInitialCronState } from "../../lib/cron/index.ts";
import {
  clearCronRunsPage,
  getCronRunsViewState,
  loadCronRuns,
  loadCronRunsForJob,
  retireCronRunsRequest,
  type CronRunsViewState,
} from "../../lib/cron/runs.ts";
import type { CronState } from "../../lib/cron/types.ts";
import { AutomationChatJobsData } from "./automation-chat-jobs-data.ts";
import { loadChildJobRuns, mergeRuns } from "./automation-runs-child-fork.ts";

/** Runs shown per page; the Automations Run history pages the same `cron.runs` log. */
export const AUTOMATION_RUNS_PAGE_SIZE = 20;

/**
 * Run history of the open automation chat's own automation, newest first (`cron.runs` for its job).
 * Fork: jobs set up from this chat add their latest runs (automation-runs-child-fork.ts).
 */
export class AutomationRunsPanelData extends AutomationChatJobsData {
  readonly cron: CronState = createInitialCronState();

  constructor(context: ApplicationContext, changed: () => void) {
    super(context, changed);
    this.cron.cronRunsLimit = AUTOMATION_RUNS_PAGE_SIZE;
    this.cron.cronRunsScope = "job";
    this.cron.canRefresh = () => this.current(this.generation);
  }

  /** Fork: latest runs of the jobs set up from this chat. */
  childRuns: CronRunLogEntry[] = [];

  get runs(): readonly CronRunLogEntry[] {
    return mergeRuns(this.cron.cronRuns, this.childRuns);
  }

  get runsState(): CronRunsViewState {
    return getCronRunsViewState(this.cron);
  }

  /** The job name shown on a run when the chat collects runs of more than one job. */
  get showJobNames(): boolean {
    return this.runs.some((entry) => entry.jobId !== this.jobId);
  }

  /** The connection the run viewer reads `cron.history` on, while it still belongs here. */
  captureTranscriptScope() {
    const scope = this.scope;
    const generation = this.generation;
    return scope
      ? { client: scope.client, isCurrent: () => this.current(generation) && !this.deleted }
      : null;
  }

  override async refresh(options?: { coalesce?: boolean; finished?: boolean }): Promise<void> {
    const scope = this.scope;
    const jobId = this.jobId;
    const generation = this.generation;
    if (!scope || !jobId || !this.current(generation)) {
      return;
    }
    const loaded = this.cron.cronRunsScope === "job" && this.cron.cronRunsJobId === jobId;
    if (options?.coalesce && !options.finished && loaded) {
      // A started or edited job changes the Run button, not the finished-run history.
      await this.loadJobs();
      return;
    }
    this.cron.client = scope.client;
    this.cron.connected = true;
    const runs =
      options?.coalesce && loaded
        ? loadCronRuns(this.cron, { coalesce: true })
        : loadCronRunsForJob(this.cron, jobId);
    this.changed();
    await Promise.all([this.loadJobs(), runs]);
    if (!this.current(generation)) {
      return;
    }
    const children = await loadChildJobRuns(scope.client, this.jobs, jobId);
    if (!this.current(generation)) {
      return;
    }
    this.childRuns = children;
    if (this.deleted) {
      // History of a removed automation is not offered: its transcripts and route are gone too.
      retireCronRunsRequest(this.cron);
      clearCronRunsPage(this.cron);
    }
    this.changed();
  }

  async loadMore(): Promise<void> {
    if (!this.current(this.generation) || this.deleted) {
      return;
    }
    const pending = loadCronRuns(this.cron, { append: true });
    this.changed();
    await pending;
    this.changed();
  }

  protected override retire(): void {
    super.retire();
    this.childRuns = [];
    retireCronRunsRequest(this.cron);
    clearCronRunsPage(this.cron);
    this.cron.cronRunsJobId = null;
    this.cron.cronRunsLoadingMore = false;
    this.cron.client = null;
    this.cron.connected = false;
  }
}
