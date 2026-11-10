import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { FailoverError } from "../failover-error.js";
import {
  closePluginTestAdmissions,
  createExecution,
  runPlugin,
  SUCCESS_RESULT,
  waitUntilAborted,
} from "./execute-plugin.test-support.js";

const REQUESTING = { type: "system", subtype: "status", status: "requesting" };
// The smallest first-byte window the CLI accepts; keeps fake-timer runs short.
const FIRST_BYTE_ENV = { CLAUDE_STREAM_FIRST_BYTE_TIMEOUT_MS: "10000" };

afterEach(() => {
  closePluginTestAdmissions();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("plugin-owned CLI execution: silent native waits", () => {
  it("lets the CLI's own first-byte window run out before the no-output watchdog fires", async () => {
    vi.useFakeTimers();
    const { context } = await createExecution({ timeoutMs: 600_000 });
    const received: string[] = [];
    const timeout = vi.fn<(error: FailoverError) => void>();
    let settled = false;
    const run = runPlugin(
      context,
      async function* (execution) {
        yield REQUESTING;
        await waitUntilAborted(execution);
        yield SUCCESS_RESULT;
      },
      {
        noOutputTimeoutMs: 1_000,
        env: FIRST_BYTE_ENV,
        consumeStdout: received.push.bind(received),
        onNoOutputTimeout: timeout,
      },
    ).finally(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(received).toHaveLength(1));

    // 10 s CLI window plus the 30 s margin.
    await vi.advanceTimersByTimeAsync(35_000);
    expect(settled).toBe(false);
    expect(timeout).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(7_000);
    await expect(run).resolves.toMatchObject({ reason: "no-output-timeout" });
    expect(timeout.mock.calls[0]?.[0]?.cliTimeout).toMatchObject({ awaitingModelResponse: true });
  });

  it("extends the wait to the retry window the CLI announces after no response", async () => {
    vi.useFakeTimers();
    const { context } = await createExecution({ timeoutMs: 600_000 });
    const retried = createDeferred();
    const received: string[] = [];
    let settled = false;
    const run = runPlugin(
      context,
      async function* (execution) {
        yield REQUESTING;
        await retried.promise;
        yield {
          type: "system",
          subtype: "api_retry",
          attempt: 1,
          max_retries: 1,
          retry_delay_ms: 0,
          error_status: null,
          error: "unknown",
          no_response: { waited_ms: 10_000, retry_wait_ms: 60_000 },
        };
        yield REQUESTING;
        await waitUntilAborted(execution);
        yield SUCCESS_RESULT;
      },
      {
        noOutputTimeoutMs: 1_000,
        env: FIRST_BYTE_ENV,
        consumeStdout: received.push.bind(received),
      },
    ).finally(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(received).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(10_000);
    retried.resolve();
    await vi.waitFor(() => expect(received).toHaveLength(3));

    // The retry's own `requesting` frame keeps the longer window: 60 s + 30 s margin.
    await vi.advanceTimersByTimeAsync(85_000);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(7_000);
    await expect(run).resolves.toMatchObject({ reason: "no-output-timeout" });
  });

  it("uses the ordinary watchdog once the model has started to answer", async () => {
    vi.useFakeTimers();
    const { context } = await createExecution({ timeoutMs: 600_000 });
    const received: string[] = [];
    const timeout = vi.fn<(error: FailoverError) => void>();
    const run = runPlugin(
      context,
      async function* (execution) {
        yield REQUESTING;
        yield { type: "stream_event", event: { type: "message_start" } };
        await waitUntilAborted(execution);
        yield SUCCESS_RESULT;
      },
      {
        noOutputTimeoutMs: 1_000,
        env: FIRST_BYTE_ENV,
        consumeStdout: received.push.bind(received),
        onNoOutputTimeout: timeout,
      },
    );
    await vi.waitFor(() => expect(received).toHaveLength(2));

    await vi.advanceTimersByTimeAsync(2_000);
    await expect(run).resolves.toMatchObject({ reason: "no-output-timeout" });
    expect(timeout.mock.calls[0]?.[0]?.cliTimeout?.awaitingModelResponse).toBeUndefined();
  });

  it("reports background agents, then the wait for them after the answer", async () => {
    const { context } = await createExecution();
    const states: unknown[] = [];
    await expect(
      runPlugin(
        context,
        async function* () {
          yield {
            type: "system",
            subtype: "background_tasks_changed",
            tasks: [
              { task_id: "agent-1", task_type: "local_agent", description: "Review the parser" },
              { task_id: "agent-2", task_type: "local_agent", description: "Check the docs" },
              { task_id: "watcher", task_type: "monitor", description: "watch", ambient: true },
            ],
          };
          yield { ...SUCCESS_RESULT, openclaw_interim_result: true };
          yield {
            type: "system",
            subtype: "background_tasks_changed",
            tasks: [
              { task_id: "agent-2", task_type: "local_agent", description: "Check the docs" },
            ],
          };
          yield { type: "system", subtype: "background_tasks_changed", tasks: [] };
          yield SUCCESS_RESULT;
        },
        { onBackgroundTasksChange: (state) => states.push(state) },
      ),
    ).resolves.toMatchObject({ reason: "exit" });

    expect(states).toEqual([
      {
        count: 2,
        agents: 2,
        waiting: false,
        tasks: [
          { taskId: "agent-1", taskType: "local_agent", description: "Review the parser" },
          { taskId: "agent-2", taskType: "local_agent", description: "Check the docs" },
        ],
      },
      expect.objectContaining({ count: 2, waiting: true }),
      expect.objectContaining({ count: 1, agents: 1, waiting: true }),
      { count: 0, agents: 0, waiting: false, tasks: [] },
    ]);
  });

  it("clears the background line when the run ends with tasks still listed", async () => {
    const { context } = await createExecution();
    const states: Array<{ count: number }> = [];
    await runPlugin(
      context,
      async function* () {
        yield {
          type: "system",
          subtype: "background_tasks_changed",
          tasks: [{ task_id: "shell-1", task_type: "local_bash", description: "npm test" }],
        };
        yield SUCCESS_RESULT;
      },
      { onBackgroundTasksChange: (state) => states.push(state) },
    );

    expect(states.map((state) => state.count)).toEqual([1, 0]);
  });
});
