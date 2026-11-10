import { For, Show } from "solid-js";
import { ElapsedTime } from "../../../components/elapsed-time.tsx";
import { t } from "../../../i18n/index.ts";
import {
  formatCliBackgroundTasksLabel,
  formatCliBackgroundTaskType,
} from "../cli-background-tasks.ts";
import type { CliBackgroundTaskRow, CliBackgroundTasksStatus } from "../tool-stream-contract.ts";

/** Resolves whether the CLI accepted the stop request for the task. */
export type CliBackgroundTaskStop = (taskId: string) => Promise<boolean>;

function taskName(task: CliBackgroundTaskRow): string {
  return task.description ?? formatCliBackgroundTaskType(task);
}

async function stopTask(event: Event, task: CliBackgroundTaskRow, onStop: CliBackgroundTaskStop) {
  const button = event.currentTarget as HTMLButtonElement;
  button.disabled = true;
  button.textContent = t("chat.backgroundTasks.stopping");
  const requested = await onStop(task.taskId).catch(() => false);
  if (!requested) {
    // The row stays until the CLI reports the task's end; a refused stop can be retried.
    button.disabled = false;
    button.textContent = t("chat.backgroundTasks.stop");
    button.title = t("chat.backgroundTasks.stopUnavailable");
  }
}

function statusLabel(status: CliBackgroundTaskRow["status"]): string {
  switch (status) {
    case "completed":
      return t("chat.backgroundTasks.status.completed");
    case "failed":
      return t("chat.backgroundTasks.status.failed");
    case "stopped":
      return t("chat.backgroundTasks.status.stopped");
    default:
      return t("chat.backgroundTasks.status.running");
  }
}

function TaskRow(props: { task: CliBackgroundTaskRow; onStop?: CliBackgroundTaskStop }) {
  const name = () => taskName(props.task);
  return (
    <li
      class={`chat-cli-tasks__row chat-cli-tasks__row--${props.task.status}`}
      data-task-id={props.task.taskId}
    >
      <span class="chat-cli-tasks__name" title={name()}>
        {name()}
      </span>
      <span class="chat-cli-tasks__type">{formatCliBackgroundTaskType(props.task)}</span>
      <Show when={props.task.startedAt}>
        {(startedAt) => (
          <ElapsedTime
            class="chat-cli-tasks__elapsed"
            startMs={startedAt()}
            endMs={props.task.endedAt ?? null}
          />
        )}
      </Show>
      <span class="chat-cli-tasks__status">{statusLabel(props.task.status)}</span>
      <Show when={props.onStop && props.task.status === "running" ? props.onStop : undefined}>
        {(onStop) => (
          <button
            class="chat-cli-tasks__stop"
            type="button"
            aria-label={t("chat.backgroundTasks.stopLabel", { name: name() })}
            onClick={(event) => void stopTask(event, props.task, onStop())}
          >
            {t("chat.backgroundTasks.stop")}
          </button>
        )}
      </Show>
    </li>
  );
}

/**
 * Fork (F47): Claude CLI background agents and tasks as an expandable list whose summary
 * is the F33 counter line ("2 background agents running"). Without rows (older gateways)
 * the counter stays a plain line.
 */
export function CliBackgroundTasks(props: {
  status: CliBackgroundTasksStatus | null | undefined;
  onStop?: CliBackgroundTaskStop;
}) {
  const label = () => formatCliBackgroundTasksLabel(props.status);
  const tasks = () => props.status?.tasks ?? [];
  return (
    <Show when={label()}>
      {(text) => (
        <Show
          when={tasks().length > 0}
          fallback={<span class="chat-working-indicator__background-tasks">{text()}</span>}
        >
          <details class="chat-cli-tasks">
            <summary class="chat-working-indicator__background-tasks chat-cli-tasks__summary">
              {text()}
            </summary>
            <ul class="chat-cli-tasks__list" aria-label={t("chat.backgroundTasks.listLabel")}>
              <For each={tasks()} keyed={(task) => task.taskId}>
                {(task) => <TaskRow task={task()} onStop={props.onStop} />}
              </For>
            </ul>
          </details>
        </Show>
      )}
    </Show>
  );
}
