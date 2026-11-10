import { isRecord } from "@openclaw/normalization-core/record-coerce";

/**
 * Fork: Claude CLI states that are silent on stdout but still progress.
 *
 * Model request (F36). While an API request waits for its first byte the CLI writes
 * nothing. It enforces its own first-byte window (180 s by default,
 * `CLAUDE_STREAM_FIRST_BYTE_TIMEOUT_MS`), then retries once with a longer window and
 * announces the retry as `{"type":"system","subtype":"api_retry","no_response":
 * {"waited_ms","retry_wait_ms"}}`. A request starts with
 * `{"type":"system","subtype":"status","status":"requesting"}`. Until the first
 * response frame arrives, the host no-output watchdog waits for the CLI window plus
 * a margin instead of racing the CLI's own timeout.
 *
 * Background tasks (F33). `system/background_tasks_changed` carries the full set of
 * live background tasks (replace semantics); `ambient` entries are housekeeping and
 * not activity.
 */
export const CLAUDE_CLI_FIRST_BYTE_WINDOW_MS = 180_000;
export const CLI_MODEL_REQUEST_GRACE_MARGIN_MS = 30_000;
const FIRST_BYTE_WINDOW_MIN_MS = 10_000;
const FIRST_BYTE_WINDOW_MAX_MS = 30 * 60_000;

function clampWindowMs(value: number): number {
  return Math.min(FIRST_BYTE_WINDOW_MAX_MS, Math.max(FIRST_BYTE_WINDOW_MIN_MS, value));
}

function readNonNegativeMs(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function resolveClaudeCliFirstByteWindowMs(
  env: Readonly<Record<string, string | undefined>> | undefined,
): number {
  const raw = env?.CLAUDE_STREAM_FIRST_BYTE_TIMEOUT_MS?.trim();
  const configured = raw && /^\d+$/.test(raw) ? Number(raw) : undefined;
  return configured !== undefined && configured > 0
    ? clampWindowMs(configured)
    : CLAUDE_CLI_FIRST_BYTE_WINDOW_MS;
}

/** Records that prove the model answered: the first byte of a response, or a turn boundary. */
function endsModelRequestWait(record: Record<string, unknown>): boolean {
  return (
    record.type === "stream_event" ||
    record.type === "assistant" ||
    record.type === "user" ||
    record.type === "result"
  );
}

export function createCliModelRequestWait(params: {
  env?: Readonly<Record<string, string | undefined>>;
  marginMs?: number;
}) {
  const firstByteWindowMs = resolveClaudeCliFirstByteWindowMs(params.env);
  const marginMs = params.marginMs ?? CLI_MODEL_REQUEST_GRACE_MARGIN_MS;
  let awaitingWindowMs: number | undefined;
  // A no-response retry keeps its longer window across the retry's own `requesting` frame.
  let retryWindowMs: number | undefined;
  return {
    observe(record: Record<string, unknown>) {
      if (endsModelRequestWait(record)) {
        awaitingWindowMs = undefined;
        retryWindowMs = undefined;
        return;
      }
      if (record.type !== "system") {
        return;
      }
      if (record.subtype === "status" && record.status === "requesting") {
        awaitingWindowMs = Math.max(retryWindowMs ?? 0, firstByteWindowMs);
        return;
      }
      if (record.subtype !== "api_retry") {
        return;
      }
      const delayMs = readNonNegativeMs(record.retry_delay_ms) ?? 0;
      const noResponse = isRecord(record.no_response) ? record.no_response : undefined;
      const retryWaitMs = readNonNegativeMs(noResponse?.retry_wait_ms);
      if (retryWaitMs !== undefined && retryWaitMs > 0) {
        retryWindowMs = clampWindowMs(retryWaitMs);
      }
      awaitingWindowMs = Math.min(
        FIRST_BYTE_WINDOW_MAX_MS,
        delayMs + (retryWindowMs ?? firstByteWindowMs),
      );
    },
    /** Silence the watchdog should allow, counted from the last output; undefined when idle. */
    graceMs: (): number | undefined =>
      awaitingWindowMs === undefined ? undefined : awaitingWindowMs + marginMs,
    isAwaiting: () => awaitingWindowMs !== undefined,
  };
}

export type CliModelRequestWait = ReturnType<typeof createCliModelRequestWait>;

export type CliBackgroundTasksSnapshot = {
  /** Live, non-ambient background tasks. */
  count: number;
  /** Of `count`, subagents (`local_agent`). */
  agents: number;
  tasks: Array<{ taskId: string; taskType: string; description?: string }>;
};

/** Reads a `system/background_tasks_changed` record; undefined for any other record. */
export function readCliBackgroundTasksSnapshot(
  record: Record<string, unknown>,
): CliBackgroundTasksSnapshot | undefined {
  if (
    record.type !== "system" ||
    record.subtype !== "background_tasks_changed" ||
    !Array.isArray(record.tasks)
  ) {
    return undefined;
  }
  const tasks: CliBackgroundTasksSnapshot["tasks"] = [];
  for (const task of record.tasks) {
    if (!isRecord(task) || task.ambient === true || typeof task.task_id !== "string") {
      continue;
    }
    const description =
      typeof task.description === "string" && task.description.trim()
        ? task.description.trim().slice(0, 200)
        : undefined;
    tasks.push({
      taskId: task.task_id,
      taskType: typeof task.task_type === "string" ? task.task_type : "unknown",
      ...(description ? { description } : {}),
    });
  }
  return {
    count: tasks.length,
    agents: tasks.filter((task) => task.taskType === "local_agent").length,
    tasks,
  };
}

export type CliBackgroundTasksState = CliBackgroundTasksSnapshot & {
  /** The answer is in; the turn stays open only for this background work. */
  waiting: boolean;
};

/**
 * Observes each structured CLI record for silent native waits: the pending model request
 * (watchdog grace) and live background tasks (reported to `onBackgroundTasksChange`).
 */
export function createCliNativeWaitObserver(
  env: Readonly<Record<string, string | undefined>> | undefined,
  onBackgroundTasksChange?: (state: CliBackgroundTasksState) => void,
) {
  const modelRequestWait = createCliModelRequestWait({ env });
  let snapshot: CliBackgroundTasksSnapshot | undefined;
  let waiting = false;
  const report = () => {
    if (!snapshot) {
      return;
    }
    try {
      onBackgroundTasksChange?.({ ...snapshot, waiting });
    } catch {
      // Presentation only; it must not end the turn.
    }
  };
  return {
    modelRequestGraceMs: modelRequestWait.graceMs,
    observe(record: Record<string, unknown>) {
      modelRequestWait.observe(record);
      const next = readCliBackgroundTasksSnapshot(record);
      if (next && (next.count > 0 || (snapshot?.count ?? 0) > 0)) {
        snapshot = next;
        // Once the set drains, the CLI answers the notifications: no longer a wait.
        waiting &&= next.count > 0;
        report();
      }
      // A held (interim) result means the answer is in and the turn stays open for the tasks.
      if (
        record.type === "result" &&
        record.openclaw_interim_result === true &&
        !waiting &&
        (snapshot?.count ?? 0) > 0
      ) {
        waiting = true;
        report();
      }
    },
    /** The run is over; whatever the CLI still runs no longer belongs to it. */
    finish() {
      if ((snapshot?.count ?? 0) > 0) {
        snapshot = { count: 0, agents: 0, tasks: [] };
        waiting = false;
        report();
      }
    },
  };
}
