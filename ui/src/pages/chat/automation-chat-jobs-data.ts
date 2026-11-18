import { cronChatSessionKey, cronJobsDeliveringToChat } from "../../../../src/cron/run-history-chat.js";
import type { CronJob, CronJobsListResult, CronRunResult } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import { automationSessionJobId } from "../../lib/cron/automation-session.ts";
import { cronRunNotStartedMessage } from "../../lib/cron/run-feedback.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import type { SessionConnectionScope } from "../../lib/sessions/session-capability.ts";

export type AutomationChatInput = { sessionKey: string; agentId: string; presented: boolean };

/** `cron.list` pages read while looking for the jobs of one chat; 200 rows each. */
const MAX_JOB_PAGES = 5;

/** Why Run is unavailable for a job, or null when it may start now. */
export function automationRunDisabledReason(
  job: CronJob,
  pendingJobId: string | null,
): string | null {
  if (pendingJobId === job.id) {
    return t("chat.automationRuns.runStarting");
  }
  if (typeof job.state?.runningAtMs === "number") {
    return t("chat.automationRuns.runInProgress");
  }
  return null;
}

/** The last finished run of this job failed, so the action reads "Run again". */
export function automationLastRunFailed(job: CronJob): boolean {
  return (job.state?.lastRunStatus ?? job.state?.lastStatus) === "error";
}

/**
 * The jobs whose runs land in the open automation chat: the automation that owns it and any job
 * that targets it by session (`sessionTarget: session:<key>`). Also starts one of them on request,
 * exactly like Automations → Run (`cron.run`, mode force).
 */
export class AutomationChatJobsData {
  /** Owner first, then the others by name. */
  jobs: CronJob[] = [];
  jobId: string | null = null;
  chatKey: string | null = null;
  jobsLoaded = false;
  jobError: string | null = null;
  runPendingJobId: string | null = null;
  runFeedback: string | null = null;
  protected input: AutomationChatInput | null = null;
  protected scope: SessionConnectionScope | null = null;
  protected generation = 0;
  protected disposed = false;
  private readonly visibilityDocument = globalThis.document;
  private readonly visibilityChanged = () => this.reconcile();
  private readonly unsubscribe: () => void;
  private readonly unsubscribeEvents: () => void;

  constructor(
    protected readonly context: ApplicationContext,
    protected readonly changed: () => void,
  ) {
    this.unsubscribe = context.gateway.subscribe(() => this.reconcile());
    this.unsubscribeEvents = context.gateway.subscribeEvents((event) => {
      if (event.event !== "cron" || !this.scope || !this.jobId) {
        return;
      }
      const payload = event.payload as { jobId?: unknown; action?: unknown } | undefined;
      const jobId = typeof payload?.jobId === "string" ? payload.jobId : null;
      // A new or edited job may start (or stop) targeting this chat.
      if (jobId && (this.ownsJob(jobId) || payload?.action === "added" || payload?.action === "updated")) {
        void this.refresh({ coalesce: true, finished: payload?.action === "finished" });
      }
    });
    this.visibilityDocument?.addEventListener("visibilitychange", this.visibilityChanged);
  }

  /** The automation that owns the chat, when it still exists. */
  get job(): CronJob | null {
    return this.jobs.find((job) => job.id === this.jobId) ?? null;
  }

  /** The owning automation is gone and nothing else delivers here. */
  get deleted(): boolean {
    return this.jobsLoaded && this.jobs.length === 0;
  }

  get canRun(): boolean {
    return canCallGatewayMethod(this.context.gateway.snapshot, "cron.run", "operator.admin");
  }

  ownsJob(jobId: string): boolean {
    return jobId === this.jobId || this.jobs.some((job) => job.id === jobId);
  }

  sync(input: AutomationChatInput): void {
    if (input.sessionKey !== this.input?.sessionKey || input.agentId !== this.input?.agentId) {
      this.retire();
    }
    this.input = input;
    this.jobId = automationSessionJobId(input.sessionKey);
    this.chatKey = this.jobId ? cronChatSessionKey(input.sessionKey) : null;
    this.reconcile();
  }

  protected reconcile(): void {
    if (this.disposed) {
      return;
    }
    const visible = this.input?.presented && this.visibilityDocument?.visibilityState !== "hidden";
    const scope = visible && this.jobId ? this.context.sessions.captureConnectionScope() : null;
    if (!scope) {
      if (this.scope) {
        this.retire();
        this.changed();
      }
      return;
    }
    if (this.scope && !this.context.sessions.isConnectionScopeCurrent(this.scope)) {
      this.retire();
    }
    if (!this.scope) {
      this.scope = scope;
      void this.refresh();
    }
  }

  /** Subclasses add their own reads; events pass `coalesce`, and `finished` after a run ends. */
  async refresh(_options?: { coalesce?: boolean; finished?: boolean }): Promise<void> {
    await this.loadJobs();
  }

  private jobsLoad: Promise<void> | null = null;
  private jobsDirty = false;

  /** One `cron.list` read at a time; events during a read queue exactly one more. */
  protected loadJobs(): Promise<void> {
    if (this.jobsLoad) {
      this.jobsDirty = true;
      return this.jobsLoad;
    }
    const generation = this.generation;
    const load = this.readJobs().finally(() => {
      if (this.jobsLoad === load) {
        this.jobsLoad = null;
      }
      if (this.jobsDirty && this.current(generation)) {
        this.jobsDirty = false;
        void this.loadJobs();
      }
    });
    this.jobsLoad = load;
    return load;
  }

  private async readJobs(): Promise<void> {
    const scope = this.scope;
    const chatKey = this.chatKey;
    const generation = this.generation;
    if (!scope || !chatKey || !this.current(generation)) {
      return;
    }
    try {
      const rows: CronJob[] = [];
      for (let page = 0, offset = 0; page < MAX_JOB_PAGES; page += 1) {
        const result = await scope.client.request<CronJobsListResult>("cron.list", {
          includeDisabled: true,
          limit: 200,
          offset,
          sortBy: "name",
          sortDir: "asc",
        });
        rows.push(...(Array.isArray(result.jobs) ? result.jobs : []));
        if (!result.hasMore || result.nextOffset === null) {
          break;
        }
        offset = result.nextOffset;
      }
      if (!this.current(generation)) {
        return;
      }
      const ids = cronJobsDeliveringToChat(chatKey, rows);
      this.jobs = rows
        .filter((job) => ids.has(job.id))
        .toSorted((a, b) => Number(b.id === this.jobId) - Number(a.id === this.jobId));
      this.jobsLoaded = true;
      this.jobError = null;
    } catch (error) {
      if (this.current(generation)) {
        this.jobError = formatUiError(error);
      }
    }
    this.changed();
  }

  /** Starts the job now, as Automations → Run does; returns false when it did not start. */
  async run(jobId: string): Promise<boolean> {
    const scope = this.scope;
    const generation = this.generation;
    const job = this.jobs.find((candidate) => candidate.id === jobId);
    if (!scope || !job || !this.canRun || automationRunDisabledReason(job, this.runPendingJobId)) {
      return false;
    }
    this.runPendingJobId = jobId;
    this.runFeedback = null;
    this.changed();
    let started = false;
    try {
      const result = await scope.client.request<CronRunResult>("cron.run", { id: jobId, mode: "force" });
      started = result.ok && !("ran" in result && !result.ran);
      if (this.current(generation)) {
        this.runFeedback = started ? null : cronRunNotStartedMessage(result);
      }
    } catch (error) {
      if (this.current(generation)) {
        this.runFeedback = formatUiError(error);
      }
    } finally {
      if (this.current(generation)) {
        this.runPendingJobId = null;
        this.changed();
        void this.refresh({ coalesce: true });
      }
    }
    return started;
  }

  protected current(generation: number): boolean {
    return (
      !this.disposed &&
      generation === this.generation &&
      Boolean(this.scope && this.context.sessions.isConnectionScopeCurrent(this.scope))
    );
  }

  protected retire(): void {
    this.generation += 1;
    this.scope = null;
    this.jobs = [];
    this.jobsLoaded = false;
    this.jobError = null;
    this.runPendingJobId = null;
    this.runFeedback = null;
    this.jobsLoad = null;
    this.jobsDirty = false;
  }

  dispose(): void {
    this.disposed = true;
    this.retire();
    this.unsubscribe();
    this.unsubscribeEvents();
    this.visibilityDocument?.removeEventListener("visibilitychange", this.visibilityChanged);
  }
}
