import { html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import "../../../components/elapsed-time.tsx";
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

function renderRow(task: CliBackgroundTaskRow, onStop: CliBackgroundTaskStop | undefined) {
  const name = taskName(task);
  return html`<li
    class="chat-cli-tasks__row chat-cli-tasks__row--${task.status}"
    data-task-id=${task.taskId}
  >
    <span class="chat-cli-tasks__name" title=${name}>${name}</span>
    <span class="chat-cli-tasks__type">${formatCliBackgroundTaskType(task)}</span>
    ${
      task.startedAt
        ? html`<openclaw-elapsed-time
            class="chat-cli-tasks__elapsed"
            .startMs=${task.startedAt}
            .endMs=${task.endedAt ?? null}
          ></openclaw-elapsed-time>`
        : nothing
    }
    <span class="chat-cli-tasks__status">${statusLabel(task.status)}</span>
    ${
      onStop && task.status === "running"
        ? html`<button
            class="chat-cli-tasks__stop"
            type="button"
            aria-label=${t("chat.backgroundTasks.stopLabel", { name })}
            @click=${(event: Event) => void stopTask(event, task, onStop)}
          >
            ${t("chat.backgroundTasks.stop")}
          </button>`
        : nothing
    }
  </li>`;
}

/**
 * Fork (F47): Claude CLI background agents and tasks as an expandable list whose summary
 * is the F33 counter line ("2 background agents running"). Without rows (older gateways)
 * the counter stays a plain line.
 */
export function renderCliBackgroundTasks(
  status: CliBackgroundTasksStatus | null | undefined,
  onStop?: CliBackgroundTaskStop,
) {
  const label = formatCliBackgroundTasksLabel(status);
  if (!status || !label) {
    return nothing;
  }
  const tasks = status.tasks ?? [];
  if (tasks.length === 0) {
    return html`<span class="chat-working-indicator__background-tasks">${label}</span>`;
  }
  return html`<details class="chat-cli-tasks">
    <summary class="chat-working-indicator__background-tasks chat-cli-tasks__summary">
      ${label}
    </summary>
    <ul class="chat-cli-tasks__list" aria-label=${t("chat.backgroundTasks.listLabel")}>
      ${repeat(
        tasks,
        (task) => task.taskId,
        (task) => renderRow(task, onStop),
      )}
    </ul>
  </details>`;
}
