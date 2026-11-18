// Fork (F73): one **Run…** menu for an automation chat that several jobs deliver into, and the
// compact header menu (Runs + Run) that replaces the header buttons when the pane is narrow.
import { createMemo } from "solid-js";
import type { CronJob } from "../../../api/types.ts";
import { showConfirmDialog } from "../../../components/confirm-dialog.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { Menu, type MenuEntry } from "../../../components/solid/menu.tsx";
import { t } from "../../../lib/reactive/i18n.ts";
import {
  automationLastRunFailed,
  automationRunDisabledReason,
  type AutomationChatJobsData,
} from "../automation-chat-jobs-data.ts";

const RUNS_ITEM = "automation-runs";
const JOB_ITEM = "automation-run:";

let nextId = 0;

export function automationJobLabel(job: CronJob): string {
  return job.name.trim() || job.id;
}

export function automationRunLabel(job: CronJob): string {
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
    title: automationRunLabel(job),
    message: t("chat.automationRuns.runConfirm", { name: automationJobLabel(job) }),
    details: t("chat.automationRuns.runConfirmDetails"),
    confirmLabel: automationRunLabel(job),
  });
  if (confirmed) {
    await data.run(job.id);
  }
}

/** Menu rows: optionally Runs, then "Run now: <job>" / "Run again: <job>" per runnable job. */
export function automationRunMenuEntries(
  data: AutomationChatJobsData,
  opts: { runs: boolean },
): MenuEntry[] {
  const jobs = data.canRun ? data.jobs : [];
  const runs: MenuEntry[] = opts.runs
    ? [{ id: RUNS_ITEM, label: t("chat.automationRuns.runs"), icon: <Icon name="history" /> }]
    : [];
  return [
    ...runs,
    ...jobs.map((job): MenuEntry => {
      const reason = automationRunDisabledReason(job, data.runPendingJobId);
      return {
        id: `${JOB_ITEM}${job.id}`,
        label: `${automationRunLabel(job)}: ${automationJobLabel(job)}`,
        icon: <Icon name={automationLastRunFailed(job) ? "rotateCcw" : "play"} />,
        disabled: reason !== null,
        details: reason ? <span class="chat-automation-run__reason">{reason}</span> : undefined,
        attributes: {
          title: reason ?? t("chat.automationRuns.runTitle", { name: automationJobLabel(job) }),
          "data-automation-run-job": job.id,
        },
      };
    }),
  ];
}

/**
 * `compact` (narrow header): one icon button holding Runs and every Run entry. Otherwise the
 * **Run…** button for several jobs.
 */
export function AutomationRunMenu(props: {
  data: () => AutomationChatJobsData;
  compact?: boolean;
  onOpenRuns?: () => void;
}) {
  const id = `automation-run-menu-${++nextId}`;
  const items = createMemo(() =>
    automationRunMenuEntries(props.data(), { runs: Boolean(props.compact && props.onOpenRuns) }),
  );
  return (
    <Menu
      id={id}
      class={props.compact ? "chat-automation-header__compact-menu" : "chat-automation-run__menu"}
      label={props.compact ? t("chat.automationRuns.actions") : t("chat.automationRuns.runMenu")}
      placement="bottom-end"
      triggerClass={
        props.compact
          ? "btn btn--sm btn--ghost btn--icon chat-automation-header__compact"
          : "btn btn--sm chat-automation-run__button"
      }
      triggerAttributes={{
        title: props.compact
          ? t("chat.automationRuns.actions")
          : t("chat.automationRuns.runMenuTitle"),
        "data-test-id": props.compact ? "automation-header-compact" : "automation-run-menu",
      }}
      trigger={
        props.compact ? (
          <Icon name="history" />
        ) : (
          <>
            <Icon name="play" />
            {t("chat.automationRuns.runMenu")}
          </>
        )
      }
      items={items()}
      onSelect={(item) => {
        if (item.id === RUNS_ITEM) {
          props.onOpenRuns?.();
          return;
        }
        const job = props.data().jobs.find((entry) => `${JOB_ITEM}${entry.id}` === item.id);
        if (job) {
          void confirmAndRunAutomation(props.data(), job);
        }
      }}
    />
  );
}
