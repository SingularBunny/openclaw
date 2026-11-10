import { t } from "../../i18n/index.ts";
import type {
  AgentEventPayload,
  CliBackgroundTasksStatus,
  ToolStreamHost,
} from "./tool-stream-contract.ts";

function readCount(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
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
  host.cliBackgroundTasks = {
    runId: payload.runId,
    count,
    agents: Math.min(count, readCount(payload.data?.agents)),
    waiting: payload.data?.waiting === true,
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
