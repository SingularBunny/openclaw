import { afterEach, describe, expect, it, vi } from "vitest";
import { createClaudeTodoProgressCardWriter } from "./claude-todos-progress-card.js";
import {
  createClaudeCliTodoObserver,
  projectClaudeTodoSteps,
  readClaudeTaskListItems,
  resetClaudeTodoSessionsForTest,
} from "./claude-todos.js";

const toolUse = (id: string, name: string, input: unknown, parent?: string) => ({
  type: "assistant",
  ...(parent ? { parent_tool_use_id: parent } : { parent_tool_use_id: null }),
  message: { content: [{ type: "tool_use", id, name, input }] },
});

const toolResult = (
  id: string,
  content: unknown,
  extra: { isError?: boolean; structured?: unknown } = {},
) => ({
  type: "user",
  parent_tool_use_id: null,
  message: {
    content: [
      {
        type: "tool_result",
        tool_use_id: id,
        content,
        ...(extra.isError ? { is_error: true } : {}),
      },
    ],
  },
  ...(extra.structured ? { tool_use_result: extra.structured } : {}),
});

function observe(stateKey = "session-a") {
  const changes: Array<Array<{ step: string; status: string }>> = [];
  const observer = createClaudeCliTodoObserver({
    stateKey,
    onChange: (steps) => changes.push(steps),
  });
  return { observer, changes };
}

afterEach(() => {
  resetClaudeTodoSessionsForTest();
});

describe("Claude CLI todo list", () => {
  it("replaces the list from TodoWrite once the call succeeds", () => {
    const { observer, changes } = observe();
    observer.observe(
      toolUse("t1", "TodoWrite", {
        todos: [
          { content: "Read the spec", status: "completed", activeForm: "Reading the spec" },
          { content: "Write the parser", status: "in_progress", activeForm: "Writing" },
          { content: "Run tests", status: "pending", activeForm: "Running tests" },
        ],
      }),
    );
    expect(changes).toEqual([]);
    observer.observe(toolResult("t1", "Todos have been modified successfully."));
    expect(changes).toEqual([
      [
        { step: "Read the spec", status: "completed" },
        { step: "Write the parser", status: "in_progress" },
        { step: "Run tests", status: "pending" },
      ],
    ]);
  });

  it("ignores failed calls and subagent todo lists", () => {
    const { observer, changes } = observe();
    observer.observe(toolUse("t1", "TodoWrite", { todos: [{ content: "A", status: "pending" }] }));
    observer.observe(toolResult("t1", "denied", { isError: true }));
    observer.observe(
      toolUse("t2", "TodoWrite", { todos: [{ content: "B", status: "pending" }] }, "agent-call"),
    );
    observer.observe({ ...toolResult("t2", "ok"), parent_tool_use_id: "agent-call" });
    expect(changes).toEqual([]);
  });

  it("builds the list from TaskCreate and TaskUpdate across turns of one session", () => {
    const first = observe();
    first.observer.observe(
      toolUse("c1", "TaskCreate", { subject: "Collect data", description: "d", activeForm: "x" }),
    );
    first.observer.observe(
      toolResult("c1", "Task #1 created successfully: Collect data", {
        structured: { task: { id: "1", subject: "Collect data" } },
      }),
    );
    first.observer.observe(toolUse("c2", "TaskCreate", { subject: "Check totals" }));
    first.observer.observe(toolResult("c2", "Task #2 created successfully: Check totals"));
    first.observer.observe(toolUse("u1", "TaskUpdate", { taskId: "1", status: "in_progress" }));
    first.observer.observe(toolResult("u1", "Updated task #1 status"));
    expect(first.changes.at(-1)).toEqual([
      { step: "Collect data", status: "in_progress" },
      { step: "Check totals", status: "pending" },
    ]);

    // The next turn of the same session still knows task #2.
    const second = observe();
    second.observer.observe(toolUse("u2", "TaskUpdate", { taskId: "2", status: "completed" }));
    second.observer.observe(toolResult("u2", "Updated task #2 status"));
    second.observer.observe(toolUse("u3", "TaskUpdate", { taskId: "1", status: "deleted" }));
    second.observer.observe(toolResult("u3", "Updated task #1 deleted"));
    expect(second.changes).toEqual([
      [
        { step: "Collect data", status: "in_progress" },
        { step: "Check totals", status: "completed" },
      ],
      [{ step: "Check totals", status: "completed" }],
    ]);

    // Another session starts empty: an unknown task id changes nothing.
    const other = observe("session-b");
    other.observer.observe(toolUse("u4", "TaskUpdate", { taskId: "2", status: "pending" }));
    other.observer.observe(toolResult("u4", "Updated"));
    expect(other.changes).toEqual([]);
  });

  it("reads TaskList results as the whole list", () => {
    expect(
      readClaudeTaskListItems("#1 [completed] Collect data\n#2 [pending] Check totals (owner)", {}),
    ).toEqual([
      { id: "1", text: "Collect data", status: "completed" },
      { id: "2", text: "Check totals (owner)", status: "pending" },
    ]);
    expect(readClaudeTaskListItems("No tasks found", undefined)).toEqual([]);
    expect(
      readClaudeTaskListItems("", { tasks: [{ id: "3", subject: "Ship", status: "in_progress" }] }),
    ).toEqual([{ id: "3", text: "Ship", status: "in_progress" }]);
    expect(readClaudeTaskListItems("unrelated text", undefined)).toBeUndefined();
  });

  it("keeps at most one step in progress and the card size limits", () => {
    const steps = projectClaudeTodoSteps([
      { text: "a", status: "in_progress" },
      { text: "b", status: "in_progress" },
      { text: "x".repeat(600), status: "pending" },
    ]);
    expect(steps.map((step) => step.status)).toEqual(["in_progress", "pending", "pending"]);
    expect(steps[2]?.step).toHaveLength(512);
    expect(
      projectClaudeTodoSteps(
        Array.from({ length: 60 }, (_, index) => ({ text: `s${index}`, status: "pending" })),
      ),
    ).toHaveLength(50);
  });
});

describe("Claude todo progress card writer", () => {
  it("serializes writes, keeps only the latest queued list and clears on empty", async () => {
    let release: (() => void) | undefined;
    const call = vi.fn(
      () =>
        new Promise<unknown>((resolve) => {
          release = () => resolve({});
        }),
    );
    const writer = createClaudeTodoProgressCardWriter({
      sessionKey: "agent:main:main",
      agentId: "main",
      call,
    });
    writer.write([{ step: "a", status: "pending" }]);
    writer.write([{ step: "b", status: "pending" }]);
    writer.write([]);
    expect(call).toHaveBeenCalledTimes(1);
    release?.();
    await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(2));
    release?.();
    await writer.idle();
    expect(call.mock.calls).toEqual([
      [
        "progressCard.put",
        { timeoutMs: 10_000 },
        {
          sessionKey: "agent:main:main",
          agentId: "main",
          plan: [{ step: "a", status: "pending" }],
        },
      ],
      [
        "progressCard.put",
        { timeoutMs: 10_000 },
        { sessionKey: "agent:main:main", agentId: "main" },
      ],
    ]);
  });

  it("keeps writing after a failed write", async () => {
    const call = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue({});
    const writer = createClaudeTodoProgressCardWriter({ sessionKey: "agent:main:main", call });
    writer.write([{ step: "a", status: "pending" }]);
    await writer.idle();
    writer.write([{ step: "a", status: "completed" }]);
    await writer.idle();
    expect(call).toHaveBeenCalledTimes(2);
  });
});
