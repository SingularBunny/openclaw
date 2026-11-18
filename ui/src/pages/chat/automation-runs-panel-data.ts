import type { CronRunLogEntry } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { createInitialCronState } from "../../lib/cron/index.ts";
import {
  clearCronRunsPage,
  getCronRunsViewState,
  loadCronRuns,
  loadCronRunsForChat,
  retireCronRunsRequest,
  type CronRunsViewState,
} from "../../lib/cron/runs.ts";
import type { CronState } from "../../lib/cron/types.ts";
import { AutomationChatJobsData } from "./automation-chat-jobs-data.ts";

/** Runs shown per page; the Automations Run history pages the same `cron.runs` log. */
export const AUTOMATION_RUNS_PAGE_SIZE = 20;

/**
 * Run history of the open automation chat: every run that lands in it, from the automation that
 * owns it and from jobs that target it by session, newest first (`cron.runs` with `sessionKey`).
 */
export class AutomationRunsPanelData extends AutomationChatJobsData {
  readonly cron: CronState = createInitialCronState();

  constructor(context: ApplicationContext, changed: () => void) {
    super(context, changed);
    this.cron.cronRunsLimit = AUTOMATION_RUNS_PAGE_SIZE;
    this.cron.cronRunsScope = "all";
    this.cron.canRefresh = () => this.current(this.generation);
  }

  get runs(): readonly CronRunLogEntry[] {
    return this.cron.cronRuns;
  }

  get runsState(): CronRunsViewState {
    return getCronRunsViewState(this.cron);
  }

  /** The job name shown on a run when the chat collects runs of more than one job. */
  get showJobNames(): boolean {
    return this.jobs.length > 1 || this.runs.some((entry) => entry.jobId !== this.jobId);
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
    const chatKey = this.chatKey;
    const generation = this.generation;
    if (!scope || !chatKey || !this.current(generation)) {
      return;
    }
    if (options?.coalesce && !options.finished && this.cron.cronRunsSessionKey === chatKey) {
      // A started or edited job changes the Run button, not the finished-run history.
      await this.loadJobs();
      return;
    }
    this.cron.client = scope.client;
    this.cron.connected = true;
    const runs =
      options?.coalesce && this.cron.cronRunsSessionKey === chatKey
        ? loadCronRuns(this.cron, { coalesce: true })
        : loadCronRunsForChat(this.cron, chatKey);
    this.changed();
    await Promise.all([this.loadJobs(), runs]);
    if (!this.current(generation)) {
      return;
    }
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
    retireCronRunsRequest(this.cron);
    clearCronRunsPage(this.cron);
    this.cron.cronRunsJobId = null;
    this.cron.cronRunsSessionKey = null;
    this.cron.cronRunsLoadingMore = false;
    this.cron.client = null;
    this.cron.connected = false;
  }
}
