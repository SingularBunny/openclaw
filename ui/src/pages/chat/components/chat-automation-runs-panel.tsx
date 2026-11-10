import { For, Show, createMemo, createSignal, onCleanup } from "solid-js";
import type { CronRunLogEntry } from "../../../api/types.ts";
import { pathForRoute } from "../../../app-route-paths.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { formatDurationCompact } from "../../../lib/format-duration.ts";
import { formatUiExternalText } from "../../../lib/format-error.ts";
import { createMsFormatter } from "../../../lib/format.ts";
import { shouldHandleNavigationClick } from "../../../lib/navigation-click.ts";
import { useApplication } from "../../../lib/reactive/context.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../../lit/solid-bridge.ts";
import { CronRunTranscript, CronRunTranscriptView } from "../../cron/run-transcript.tsx";
import { runStatusLabel } from "../../cron/view-runs.tsx";
import { AutomationRunsPanelData } from "../automation-runs-panel-data.ts";
import { useSessionPanel, type SessionPanelProps } from "./chat-session-panel.tsx";
import "./chat-session-panels.css";
import "./chat-automation-runs-panel.css";

type Methods = { refresh(): Promise<void> };
export type ChatAutomationRunsPanel = SolidBridgeElement<SessionPanelProps, Methods>;

/** A run the viewer can address: `cron.history` needs the job and its run id or run time. */
export function canOpenAutomationRun(entry: CronRunLogEntry): boolean {
  return Boolean(
    entry.jobId &&
    (entry.runId || (typeof entry.runAtMs === "number" && Number.isFinite(entry.runAtMs))),
  );
}

function runStatusKind(entry: CronRunLogEntry): "ok" | "error" | "skipped" | "unknown" {
  if (entry.status === "ok") {
    return entry.completionStatus === "failed" ? "error" : "ok";
  }
  return entry.status === "error" || entry.status === "skipped" ? entry.status : "unknown";
}

export const ChatAutomationRunsPanel = defineSolidBridge<SessionPanelProps, Methods>(
  "openclaw-chat-automation-runs-panel",
  (props, host) => {
    const context = useApplication();
    const [transcriptRevision, setTranscriptRevision] = createSignal(0);
    // The Automations run viewer; it reads `cron.history` on the panel's current connection.
    const viewer: CronRunTranscript = new CronRunTranscript(
      host,
      () => setTranscriptRevision((value) => value + 1),
      () => data().captureTranscriptScope(),
    );
    // A new session or agent closes the open run, as the Automations page does on reselection.
    const data = useSessionPanel(props, AutomationRunsPanelData, () => viewer.close());
    onCleanup(() => viewer.close());
    host.refresh = () => data().refresh();
    const viewing = () => {
      transcriptRevision();
      return viewer.entry;
    };
    const formatTimestamp = createMemo(() =>
      createMsFormatter({ dateStyle: "medium", timeStyle: "short" }, t("common.na")),
    );
    const automationsHref = createMemo(() => {
      const jobId = data().jobId;
      if (!jobId) {
        return null;
      }
      const search = new URLSearchParams({ job: jobId });
      const runId = viewing()?.runId;
      if (runId) {
        search.set("run", runId);
      }
      return `${pathForRoute("cron", context.basePath)}?${search}`;
    });
    const openInAutomations = (event: MouseEvent) => {
      const href = automationsHref();
      if (!href || !shouldHandleNavigationClick(event)) {
        return;
      }
      event.preventDefault();
      context.navigate("cron", { search: href.slice(href.indexOf("?")) });
    };
    const jobName = () => {
      const job = data().job;
      return job ? job.name.trim() || job.id : null;
    };
    const duration = (entry: CronRunLogEntry) =>
      typeof entry.durationMs === "number" && Number.isFinite(entry.durationMs)
        ? (formatDurationCompact(entry.durationMs) ?? null)
        : null;
    return (
      <div
        class="chat-automation-runs"
        aria-busy={data().runsState === "pending" ? "true" : "false"}
      >
        <header class="chat-automation-runs__header">
          <span class="chat-automation-runs__name" title={jobName() ?? undefined}>
            {jobName() ?? t("chat.automationRuns.title")}
          </span>
          <Show when={!data().deleted && automationsHref()}>
            {(href) => (
              <a
                class="chat-automation-runs__open"
                href={href()}
                data-test-id="automation-runs-open-in-automations"
                onClick={openInAutomations}
              >
                {t("chat.automationRuns.openInAutomations")}
                <Icon name="externalLink" />
              </a>
            )}
          </Show>
        </header>
        <Show
          when={!data().deleted}
          fallback={
            <p
              class="chat-automation-runs__note"
              role="status"
              data-test-id="automation-runs-deleted"
            >
              {t("chat.automationRuns.deleted")}
            </p>
          }
        >
          <Show when={viewing()}>
            <div class="chat-automation-runs__transcript">
              <CronRunTranscriptView controller={viewer} revision={transcriptRevision} />
            </div>
          </Show>
          <div class="chat-automation-runs__list" hidden={Boolean(viewing())}>
            <Show when={data().jobError ?? data().cron.cronRunsError}>
              {(error) => (
                <div class="chat-automation-runs__error" role="alert">
                  {error()}
                  <button class="btn btn--sm" type="button" onClick={() => void data().refresh()}>
                    {t("common.retry")}
                  </button>
                </div>
              )}
            </Show>
            <Show
              when={data().runs.length}
              fallback={
                <p class="chat-automation-runs__note" role="status">
                  {data().runsState === "pending" || data().runsState === "idle"
                    ? t("common.loading")
                    : data().runsState === "ready"
                      ? t("chat.automationRuns.empty")
                      : null}
                </p>
              }
            >
              <ol class="chat-automation-runs__runs" data-test-id="automation-runs-list">
                <For each={data().runs} keyed={(entry) => `${entry.ts}:${entry.runId ?? ""}`}>
                  {(entry) => (
                    <li>
                      <button
                        class="chat-automation-runs__run"
                        type="button"
                        data-run-status={runStatusKind(entry())}
                        disabled={!canOpenAutomationRun(entry())}
                        title={t("chat.automationRuns.viewRun")}
                        onClick={(event) => void viewer.open(entry(), event.currentTarget)}
                      >
                        <span class="chat-automation-runs__run-line">
                          <span class="chat-automation-runs__time">
                            {formatTimestamp()(entry().runAtMs ?? entry().ts)}
                          </span>
                          <span class="chat-automation-runs__status">
                            {runStatusLabel(entry().status ?? "unknown", entry().completionStatus)}
                          </span>
                          <Show when={duration(entry())}>
                            {(text) => <span class="chat-automation-runs__duration">{text()}</span>}
                          </Show>
                        </span>
                        <Show when={entry().error}>
                          {(error) => (
                            <span class="chat-automation-runs__run-error">
                              {formatUiExternalText(error())}
                            </span>
                          )}
                        </Show>
                      </button>
                    </li>
                  )}
                </For>
              </ol>
            </Show>
            <Show when={data().cron.cronRunsHasMore}>
              <button
                class="btn btn--sm chat-automation-runs__more"
                type="button"
                disabled={data().cron.cronRunsLoadingMore}
                onClick={() => void data().loadMore()}
              >
                {data().cron.cronRunsLoadingMore ? t("common.loading") : t("cron.runs.loadMore")}
              </button>
            </Show>
          </div>
        </Show>
      </div>
    );
  },
  {
    properties: {
      sessionKey: { default: "", attribute: false },
      agentId: { default: "main", attribute: false },
      presented: { default: true, type: Boolean },
    },
    methods: { refresh: () => Promise.resolve() },
  },
);

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-chat-automation-runs-panel": ChatAutomationRunsPanel;
  }
}
