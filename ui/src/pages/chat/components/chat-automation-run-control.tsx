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
          <wa-dropdown
            class="chat-automation-run__menu"
            placement="bottom-end"
            onWa-select={(event) => {
              const job = jobs().find((candidate) => candidate.id === event.detail.item.value);
              if (job && reason(job) === null) {
                run(job);
              }
            }}
          >
            <button
              slot="trigger"
              class="btn btn--sm chat-automation-run__button"
              type="button"
              data-test-id="automation-run-menu"
            >
              <Icon name="play" />
              {t("chat.automationRuns.runMenu")}
            </button>
            <For each={jobs()} keyed={(job) => job.id}>
              {(job) => (
                <wa-dropdown-item
                  class="session-menu__item"
                  value={job().id}
                  prop:disabled={reason(job()) !== null}
                  title={reason(job()) ?? undefined}
                >
                  {`${runLabel(job())}: ${jobLabel(job())}`}
                  <Show when={reason(job())}>
                    {(text) => <span class="chat-automation-run__reason">{text()}</span>}
                  </Show>
                </wa-dropdown-item>
              )}
            </For>
          </wa-dropdown>
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
