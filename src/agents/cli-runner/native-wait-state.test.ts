import { describe, expect, it } from "vitest";
import {
  CLAUDE_CLI_FIRST_BYTE_WINDOW_MS,
  CLI_MODEL_REQUEST_GRACE_MARGIN_MS,
  createCliModelRequestWait,
  createCliNativeWaitObserver,
  type CliBackgroundTasksState,
  readCliBackgroundTasksSnapshot,
  resolveClaudeCliFirstByteWindowMs,
} from "./native-wait-state.js";

const REQUESTING = { type: "system", subtype: "status", status: "requesting" };

describe("Claude CLI model request wait", () => {
  it("allows the CLI first-byte window plus a margin after a request starts", () => {
    const wait = createCliModelRequestWait({});
    expect(wait.graceMs()).toBeUndefined();
    wait.observe(REQUESTING);
    expect(wait.graceMs()).toBe(
      CLAUDE_CLI_FIRST_BYTE_WINDOW_MS + CLI_MODEL_REQUEST_GRACE_MARGIN_MS,
    );
    wait.observe({ type: "stream_event", event: { type: "message_start" } });
    expect(wait.isAwaiting()).toBe(false);
  });

  it("keeps a no-response retry window across the retry's own request frame", () => {
    const wait = createCliModelRequestWait({ marginMs: 0 });
    wait.observe(REQUESTING);
    wait.observe({
      type: "system",
      subtype: "api_retry",
      retry_delay_ms: 0,
      no_response: { waited_ms: 181_000, retry_wait_ms: 599_000 },
    });
    expect(wait.graceMs()).toBe(599_000);
    wait.observe(REQUESTING);
    expect(wait.graceMs()).toBe(599_000);
    wait.observe({ type: "assistant", message: { content: [] } });
    wait.observe(REQUESTING);
    expect(wait.graceMs()).toBe(CLAUDE_CLI_FIRST_BYTE_WINDOW_MS);
  });

  it("adds the retry delay of an ordinary retryable error", () => {
    const wait = createCliModelRequestWait({ marginMs: 0 });
    wait.observe({
      type: "system",
      subtype: "api_retry",
      retry_delay_ms: 5_000,
      error_status: 529,
    });
    expect(wait.graceMs()).toBe(5_000 + CLAUDE_CLI_FIRST_BYTE_WINDOW_MS);
  });

  it("ignores compaction status and other records", () => {
    const wait = createCliModelRequestWait({});
    wait.observe({ type: "system", subtype: "status", status: "compacting" });
    wait.observe({ type: "system", subtype: "task_progress" });
    expect(wait.isAwaiting()).toBe(false);
  });

  it("reads the CLI first-byte override within its bounds", () => {
    expect(resolveClaudeCliFirstByteWindowMs(undefined)).toBe(CLAUDE_CLI_FIRST_BYTE_WINDOW_MS);
    expect(resolveClaudeCliFirstByteWindowMs({ CLAUDE_STREAM_FIRST_BYTE_TIMEOUT_MS: "1" })).toBe(
      10_000,
    );
    expect(
      resolveClaudeCliFirstByteWindowMs({ CLAUDE_STREAM_FIRST_BYTE_TIMEOUT_MS: "300000" }),
    ).toBe(300_000);
    expect(resolveClaudeCliFirstByteWindowMs({ CLAUDE_STREAM_FIRST_BYTE_TIMEOUT_MS: "x" })).toBe(
      CLAUDE_CLI_FIRST_BYTE_WINDOW_MS,
    );
  });
});

describe("Claude CLI background tasks snapshot", () => {
  it("counts live tasks without ambient housekeeping", () => {
    expect(
      readCliBackgroundTasksSnapshot({
        type: "system",
        subtype: "background_tasks_changed",
        tasks: [
          { task_id: "a", task_type: "local_agent", description: "Review" },
          { task_id: "b", task_type: "local_bash", description: "  " },
          { task_id: "c", task_type: "monitor", ambient: true },
          { task_type: "local_agent" },
        ],
      }),
    ).toEqual({
      count: 2,
      agents: 1,
      tasks: [
        { taskId: "a", taskType: "local_agent", description: "Review" },
        { taskId: "b", taskType: "local_bash" },
      ],
    });
    expect(readCliBackgroundTasksSnapshot({ type: "system", subtype: "init" })).toBeUndefined();
  });
});

describe("Claude CLI background task rows", () => {
  const changed = (tasks: unknown[]) => ({
    type: "system",
    subtype: "background_tasks_changed",
    tasks,
  });

  it("lists each task with its type, start time and final status", () => {
    let clock = 1_000;
    const states: CliBackgroundTasksState[] = [];
    const observer = createCliNativeWaitObserver(
      {},
      (state) => states.push(state),
      () => clock,
    );
    observer.observe({ type: "system", subtype: "task_started", task_id: "a" });
    clock = 2_000;
    observer.observe(
      changed([
        {
          task_id: "a",
          task_type: "local_agent",
          subagent_type: "general-purpose",
          description: "Review",
        },
        { task_id: "b", task_type: "local_bash", description: "npm test" },
      ]),
    );
    expect(states.at(-1)?.tasks).toEqual([
      {
        taskId: "a",
        taskType: "local_agent",
        subagentType: "general-purpose",
        description: "Review",
        status: "running",
        startedAt: 1_000,
      },
      {
        taskId: "b",
        taskType: "local_bash",
        description: "npm test",
        status: "running",
        startedAt: 2_000,
      },
    ]);

    clock = 5_000;
    observer.observe({
      type: "system",
      subtype: "task_notification",
      task_id: "b",
      status: "failed",
    });
    observer.observe(
      changed([{ task_id: "a", task_type: "local_agent", subagent_type: "general-purpose" }]),
    );
    expect(states.at(-1)).toMatchObject({
      count: 1,
      tasks: [
        { taskId: "a", status: "running", startedAt: 1_000 },
        { taskId: "b", status: "failed", startedAt: 2_000, endedAt: 5_000 },
      ],
    });

    observer.observe(changed([]));
    expect(states.at(-1)).toEqual({ count: 0, agents: 0, tasks: [], waiting: false });
  });
});
