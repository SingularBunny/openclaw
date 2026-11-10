// @vitest-environment node
import { describe, expect, it } from "vitest";
import { formatCliBackgroundTasksLabel } from "./cli-background-tasks.ts";
import { agentEvent, createHost } from "./tool-stream.test-helpers.ts";
import { handleAgentEvent } from "./tool-stream.ts";

describe("Claude CLI background tasks line", () => {
  it("tracks the visible run's background agents and clears on an empty set", () => {
    const host = createHost({ chatRunId: "run-1" });
    handleAgentEvent(
      host,
      agentEvent("run-1", 1, "background_tasks", { count: 2, agents: 2, waiting: false }),
    );
    expect(host.cliBackgroundTasks).toEqual({
      runId: "run-1",
      count: 2,
      agents: 2,
      waiting: false,
    });
    expect(formatCliBackgroundTasksLabel(host.cliBackgroundTasks)).toBe(
      "2 background agents running",
    );

    handleAgentEvent(
      host,
      agentEvent("run-1", 2, "background_tasks", { count: 2, agents: 2, waiting: true }),
    );
    expect(formatCliBackgroundTasksLabel(host.cliBackgroundTasks)).toBe(
      "Waiting for 2 background agents to finish",
    );

    handleAgentEvent(host, agentEvent("run-1", 3, "background_tasks", { count: 0 }));
    expect(host.cliBackgroundTasks).toBeNull();
    expect(formatCliBackgroundTasksLabel(host.cliBackgroundTasks)).toBeUndefined();
  });

  it("ignores another run and another session", () => {
    const host = createHost({ chatRunId: "run-1" });
    handleAgentEvent(host, agentEvent("run-2", 1, "background_tasks", { count: 1, agents: 1 }));
    handleAgentEvent(
      host,
      agentEvent("run-1", 2, "background_tasks", { count: 1, agents: 1 }, "other"),
    );
    expect(host.cliBackgroundTasks ?? null).toBeNull();
  });

  it("names mixed work as tasks and singular counts in the singular", () => {
    expect(formatCliBackgroundTasksLabel({ runId: "r", count: 3, agents: 2, waiting: false })).toBe(
      "3 background tasks running",
    );
    expect(formatCliBackgroundTasksLabel({ runId: "r", count: 1, agents: 1, waiting: true })).toBe(
      "Waiting for 1 background agent to finish",
    );
    expect(formatCliBackgroundTasksLabel({ runId: "r", count: 1, agents: 0, waiting: false })).toBe(
      "1 background task running",
    );
  });
});
