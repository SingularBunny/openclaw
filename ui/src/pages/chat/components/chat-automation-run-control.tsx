import { Show } from "solid-js";
import type { CronJob } from "../../../api/types.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { t } from "../../../lib/reactive/i18n.ts";
import {
  automationLastRunFailed,
  automationRunDisabledReason,
  type AutomationChatJobsData,
} from "../automation-chat-jobs-data.ts";
import {
  AutomationRunMenu,
  automationJobLabel,
  automationRunLabel,
  confirmAndRunAutomation,
} from "./chat-automation-run-menu.tsx";
import "./chat-automation-run-control.css";

/**
 * Run now / Run again for the jobs that deliver into an automation chat. One job gets one button;
 * several get one **Run…** menu. Admins only (`cron.run`), like the Automations page.
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
                    reason(job()) ??
                    t("chat.automationRuns.runTitle", { name: automationJobLabel(job()) })
                  }
                  onClick={() => run(job())}
                >
                  <Icon name={automationLastRunFailed(job()) ? "rotateCcw" : "play"} />
                  {reason(job()) ?? automationRunLabel(job())}
                </button>
              )}
            </Show>
          }
        >
          <AutomationRunMenu data={props.data} />
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
