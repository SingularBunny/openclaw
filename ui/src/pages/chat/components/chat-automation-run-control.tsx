import { For, Show } from "solid-js";
import type { CronJob } from "../../../api/types.ts";
import { showConfirmDialog } from "../../../components/confirm-dialog.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { t } from "../../../lib/reactive/i18n.ts";
import {
  automationLastRunFailed,
  automationRunDisabledReason,
  type AutomationChatJobsData,
} from "../automation-chat-jobs-data.ts";
import "./chat-automation-run-control.css";

function jobLabel(job: CronJob): string {
  return job.name.trim() || job.id;
}

function runLabel(job: CronJob): string {
  return t(
    automationLastRunFailed(job) ? "chat.automationRuns.runAgain" : "chat.automationRuns.runNow",
  );
}

/** Asks first: an automation may message people (chat channels, email) when it runs. */
export async function confirmAndRunAutomation(
  data: AutomationChatJobsData,
  job: CronJob,
): Promise<void> {
  const confirmed = await showConfirmDialog({
    title: runLabel(job),
    message: t("chat.automationRuns.runConfirm", { name: jobLabel(job) }),
    details: t("chat.automationRuns.runConfirmDetails"),
    confirmLabel: runLabel(job),
  });
  if (confirmed) {
    await data.run(job.id);
  }
}

/**
 * Run now / Run again for the jobs that deliver into an automation chat. One job gets one button;
 * several get a small menu. Admins only (`cron.run`), like the Automations page.
 */
export function AutomationRunControl(props: { data: () => AutomationChatJobsData }) {
  const jobs = () => (props.data().canRun ? props.data().jobs : []);
  const reason = (job: CronJob) => automationRunDisabledReason(job, props.data().runPendingJobId);
  const run = (job: CronJob) => void confirmAndRunAutomation(props.data(), job);
  return (
    <Show when={jobs().length > 0}>
      <span class="chat-automation-run">
        <Show
          when={jobs().length > 1}
          fallback={
            <Show when={jobs()[0]}>
              {(job) => (
                <button
                  class="btn btn--sm chat-automation-run__button"
                  type="button"
                  data-test-id="automation-run-now"
                  disabled={reason(job()) !== null}
                  title={
                    reason(job()) ?? t("chat.automationRuns.runTitle", { name: jobLabel(job()) })
                  }
                  onClick={() => run(job())}
                >
                  <Icon name={automationLastRunFailed(job()) ? "rotateCcw" : "play"} />
                  {reason(job()) ?? runLabel(job())}
                </button>
              )}
            </Show>
          }
        >
          {/* Several jobs land here: one Run button per job (upstream retired wa-dropdown). */}
          <span class="chat-automation-run__menu" data-test-id="automation-run-menu">
            <For each={jobs()} keyed={(job) => job.id}>
              {(job) => (
                <button
                  class="btn btn--sm chat-automation-run__button"
                  type="button"
                  disabled={reason(job()) !== null}
                  title={reason(job()) ?? t("chat.automationRuns.runTitle", { name: jobLabel(job()) })}
                  onClick={() => run(job())}
                >
                  <Icon name={automationLastRunFailed(job()) ? "rotateCcw" : "play"} />
                  {`${runLabel(job())}: ${jobLabel(job())}`}
                </button>
              )}
            </For>
          </span>
        </Show>
        <Show when={props.data().runFeedback}>
          {(text) => (
            <span class="chat-automation-run__feedback" role="status">
              {text()}
            </span>
          )}
        </Show>
      </span>
    </Show>
  );
}
