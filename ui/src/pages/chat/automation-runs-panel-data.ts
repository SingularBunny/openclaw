import { GatewayRequestError, resolveGatewayErrorDetailCode } from "../../api/gateway.ts";
import type { CronJob, CronRunLogEntry } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { automationSessionJobId } from "../../lib/cron/automation-session.ts";
import { createInitialCronState } from "../../lib/cron/index.ts";
import {
  clearCronRunsPage,
  getCronRunsViewState,
  loadCronRuns,
  loadCronRunsForJob,
  loadMoreCronRuns,
  retireCronRunsRequest,
  type CronRunsViewState,
} from "../../lib/cron/runs.ts";
import type { CronState } from "../../lib/cron/types.ts";
import { formatUiError } from "../../lib/format-error.ts";
import type { SessionConnectionScope } from "../../lib/sessions/session-capability.ts";

/** Runs shown per page; the Automations Run history pages the same `cron.runs` log. */
export const AUTOMATION_RUNS_PAGE_SIZE = 20;

type AutomationRunsPanelInput = { sessionKey: string; agentId: string; presented: boolean };

function isCronJobNotFound(error: unknown): boolean {
  return (
    error instanceof GatewayRequestError &&
    resolveGatewayErrorDetailCode(error) === "CRON_JOB_NOT_FOUND"
  );
}

/**
 * Run history for the automation that owns the open chat. Reads go through the
 * Automations page's own `cron.get` / `cron.runs` loaders; the panel adds no history source.
 */
export class AutomationRunsPanelData {
  readonly cron: CronState = createInitialCronState();
  job: CronJob | null = null;
  jobId: string | null = null;
  /** The automation no longer exists; the panel shows a note instead of errors. */
  deleted = false;
  jobError: string | null = null;
  private input: AutomationRunsPanelInput | null = null;
  private scope: SessionConnectionScope | null = null;
  private generation = 0;
  private disposed = false;
  private readonly visibilityDocument = globalThis.document;
  private readonly visibilityChanged = () => this.reconcile();
  private readonly unsubscribe: () => void;
  private readonly unsubscribeEvents: () => void;

  constructor(
    private readonly context: ApplicationContext,
    private readonly changed: () => void,
  ) {
    this.cron.cronRunsLimit = AUTOMATION_RUNS_PAGE_SIZE;
    this.cron.cronRunsScope = "job";
    this.cron.canRefresh = () => this.current(this.generation);
    this.unsubscribe = context.gateway.subscribe(() => this.reconcile());
    this.unsubscribeEvents = context.gateway.subscribeEvents((event) => {
      if (event.event !== "cron" || !this.scope || !this.jobId || this.deleted) {
        return;
      }
      const payload = event.payload as { jobId?: unknown; action?: unknown } | undefined;
      if (payload?.jobId !== this.jobId) {
        return;
      }
      if (payload.action === "removed") {
        this.markDeleted();
        this.changed();
      } else if (payload.action === "finished" || payload.action === "updated") {
        void this.refresh({ coalesce: true });
      }
    });
    this.visibilityDocument?.addEventListener("visibilitychange", this.visibilityChanged);
  }

  get runs(): readonly CronRunLogEntry[] {
    return this.cron.cronRuns;
  }

  get runsState(): CronRunsViewState {
    return getCronRunsViewState(this.cron);
  }

  sync(input: AutomationRunsPanelInput): void {
    if (input.sessionKey !== this.input?.sessionKey || input.agentId !== this.input?.agentId) {
      this.retire();
    }
    this.input = input;
    this.jobId = automationSessionJobId(input.sessionKey);
    this.reconcile();
  }

  /** The connection the run viewer reads `cron.history` on, while it still belongs here. */
  captureTranscriptScope() {
    const scope = this.scope;
    const generation = this.generation;
    return scope
      ? { client: scope.client, isCurrent: () => this.current(generation) && !this.deleted }
      : null;
  }

  private reconcile(): void {
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

  async refresh(options?: { coalesce?: boolean }): Promise<void> {
    const scope = this.scope;
    const jobId = this.jobId;
    const generation = this.generation;
    if (!scope || !jobId || !this.current(generation)) {
      return;
    }
    this.cron.client = scope.client;
    this.cron.connected = true;
    this.jobError = null;
    const job = scope.client.request<CronJob>("cron.get", { id: jobId }).then(
      (result) => {
        if (this.current(generation)) {
          this.job = result;
          this.deleted = false;
        }
      },
      (error: unknown) => {
        if (!this.current(generation)) {
          return;
        }
        if (isCronJobNotFound(error)) {
          this.markDeleted();
        } else {
          this.jobError = formatUiError(error);
        }
      },
    );
    const runs =
      options?.coalesce && this.cron.cronRunsJobId === jobId
        ? loadCronRuns(this.cron, { coalesce: true })
        : loadCronRunsForJob(this.cron, jobId);
    this.changed();
    await Promise.all([job, runs]);
    if (this.current(generation)) {
      this.changed();
    }
  }

  async loadMore(): Promise<void> {
    if (!this.current(this.generation) || this.deleted) {
      return;
    }
    const pending = loadMoreCronRuns(this.cron);
    this.changed();
    await pending;
    this.changed();
  }

  private markDeleted(): void {
    // History of a removed automation is not offered: its transcripts and route are gone too.
    this.deleted = true;
    this.job = null;
    this.jobError = null;
    retireCronRunsRequest(this.cron);
    clearCronRunsPage(this.cron);
  }

  private current(generation: number): boolean {
    return (
      !this.disposed &&
      generation === this.generation &&
      Boolean(this.scope && this.context.sessions.isConnectionScopeCurrent(this.scope))
    );
  }

  private retire(): void {
    this.generation += 1;
    this.scope = null;
    this.job = null;
    this.deleted = false;
    this.jobError = null;
    retireCronRunsRequest(this.cron);
    clearCronRunsPage(this.cron);
    this.cron.cronRunsJobId = null;
    this.cron.cronRunsLoadingMore = false;
    this.cron.client = null;
    this.cron.connected = false;
  }

  dispose(): void {
    this.disposed = true;
    this.retire();
    this.unsubscribe();
    this.unsubscribeEvents();
    this.visibilityDocument?.removeEventListener("visibilitychange", this.visibilityChanged);
  }
}
