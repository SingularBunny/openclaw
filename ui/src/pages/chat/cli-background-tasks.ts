import { t } from "../../i18n/index.ts";
import type {
  AgentEventPayload,
  CliBackgroundTaskRow,
  CliBackgroundTasksStatus,
  ToolStreamHost,
} from "./tool-stream-contract.ts";

const MAX_TASK_ROWS = 20;

function readCount(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function readString(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;
}

function readTime(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function readTaskStatus(value: unknown): CliBackgroundTaskRow["status"] {
  return value === "completed" || value === "failed" || value === "stopped" ? value : "running";
}

/** Fork (F47): the per-task rows of a `background_tasks` event. */
export function readCliBackgroundTaskRows(value: unknown): CliBackgroundTaskRow[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const rows: CliBackgroundTaskRow[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const task = entry as Record<string, unknown>;
    const taskId = readString(task.taskId, 200);
    if (!taskId) {
      continue;
    }
    const description = readString(task.description, 200);
    const subagentType = readString(task.subagentType, 80);
    const startedAt = readTime(task.startedAt);
    const endedAt = readTime(task.endedAt);
    rows.push({
      taskId,
      taskType: readString(task.taskType, 80) ?? "unknown",
      status: readTaskStatus(task.status),
      ...(description ? { description } : {}),
      ...(subagentType ? { subagentType } : {}),
      ...(startedAt ? { startedAt } : {}),
      ...(endedAt ? { endedAt } : {}),
    });
    if (rows.length >= MAX_TASK_ROWS) {
      break;
    }
  }
  return rows;
}

/** "Explore", "Bash", "Workflow" … for a task row's type chip. */
export function formatCliBackgroundTaskType(task: CliBackgroundTaskRow): string {
  if (task.subagentType) {
    return task.subagentType;
  }
  switch (task.taskType) {
    case "local_agent":
      return "agent";
    case "local_bash":
      return "shell";
    case "local_workflow":
      return "workflow";
    default:
      return task.taskType.replace(/^local_/, "").replace(/_/g, " ");
  }
}

/**
 * Fork (F33): applies a `background_tasks` agent event (Claude CLI background agents
 * and tasks of the visible run). A zero count clears the line.
 */
export function applyCliBackgroundTasksEvent(
  host: Pick<ToolStreamHost, "cliBackgroundTasks">,
  payload: AgentEventPayload,
): void {
  const count = readCount(payload.data?.count);
  if (count === 0) {
    if (!host.cliBackgroundTasks || host.cliBackgroundTasks.runId === payload.runId) {
      host.cliBackgroundTasks = null;
    }
    return;
  }
  const tasks = readCliBackgroundTaskRows(payload.data?.tasks);
  host.cliBackgroundTasks = {
    runId: payload.runId,
    count,
    agents: Math.min(count, readCount(payload.data?.agents)),
    waiting: payload.data?.waiting === true,
    ...(tasks.length > 0 ? { tasks } : {}),
  };
}

/** "2 background agents running" / "Waiting for 2 background agents to finish". */
export function formatCliBackgroundTasksLabel(
  status: CliBackgroundTasksStatus | null | undefined,
): string | undefined {
  if (!status || status.count <= 0) {
    return undefined;
  }
  const count = String(status.count);
  const allAgents = status.agents === status.count;
  const one = status.count === 1;
  if (status.waiting) {
    return allAgents
      ? one
        ? t("chat.backgroundTasks.waitingAgentOne")
        : t("chat.backgroundTasks.waitingAgents", { count })
      : one
        ? t("chat.backgroundTasks.waitingTaskOne")
        : t("chat.backgroundTasks.waitingTasks", { count });
  }
  return allAgents
    ? one
      ? t("chat.backgroundTasks.runningAgentOne")
      : t("chat.backgroundTasks.runningAgents", { count })
    : one
      ? t("chat.backgroundTasks.runningTaskOne")
      : t("chat.backgroundTasks.runningTasks", { count });
}
