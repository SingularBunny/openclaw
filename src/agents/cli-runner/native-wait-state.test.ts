import { describe, expect, it } from "vitest";
import {
  CLAUDE_CLI_FIRST_BYTE_WINDOW_MS,
  CLI_MODEL_REQUEST_GRACE_MARGIN_MS,
  createCliModelRequestWait,
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
