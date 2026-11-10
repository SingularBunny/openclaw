import { afterEach, describe, expect, it, vi } from "vitest";
import { onAgentEvent } from "../../infra/agent-events.js";
import { createTestAdmittedRunContext } from "../admitted-run-context.test-support.js";
import { createClaudeCliTodoObserver, resetClaudeTodoSessionsForTest } from "./claude-todos.js";
import { createCliEventHandlers } from "./execute-events.js";
import type { CliToolTracking } from "./execute-tool-tracking.js";
import type { PreparedCliRunContext } from "./types.js";

const callGatewayTool = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
vi.mock("../tools/gateway.js", () => ({ callGatewayTool }));

afterEach(() => {
  resetClaudeTodoSessionsForTest();
  callGatewayTool.mockClear();
});

function createHandlers(runId: string) {
  const backend = {
    command: "claude",
    args: [],
    output: "jsonl" as const,
    input: "stdin" as const,
    serialize: true,
  };
  const context = {
    params: {
      admittedRunContext: createTestAdmittedRunContext(runId),
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      prompt: "hi",
      runId,
      provider: "claude-cli",
      model: "claude-opus-5-5",
      timeoutMs: 1_000,
    },
    started: Date.now(),
    startedMonotonicMs: performance.now(),
    workspaceDir: "/tmp",
    backendResolved: { id: "claude-cli", config: backend, bundleMcp: false },
    preparedBackend: { backend, env: {} },
    executionTarget: { kind: "process" },
    reusableCliSession: { mode: "none" },
    hadSessionFile: false,
    contextEngineConfig: {},
    modelId: "claude-opus-5-5",
    normalizedModel: "claude-opus-5-5",
    systemPrompt: "system",
    systemPromptReport: {} as PreparedCliRunContext["systemPromptReport"],
    claudeSkillsPluginArgs: [],
    authEpochVersion: 2,
  } as PreparedCliRunContext;
  const tracking = {
    handleCliToolUseStart: vi.fn(),
    handleCliToolResult: vi.fn(),
    resolveCliLoopbackTerminalOutcome: vi.fn(() => undefined),
  } as unknown as CliToolTracking;
  return createCliEventHandlers({
    context,
    toolTracking: tracking,
    getRunState: () => ({ failed: false, error: undefined }),
  });
}

// Claude Code 2.1.302 stream-json records for the Task* tools F60 enables.
const taskCreate = (id: string, subject: string) => ({
  type: "assistant",
  parent_tool_use_id: null,
  message: {
    content: [
      { type: "tool_use", id, name: "TaskCreate", input: { subject, description: subject } },
    ],
  },
});
const taskCreated = (id: string, taskId: string, subject: string) => ({
  type: "user",
  parent_tool_use_id: null,
  message: {
    content: [
      {
        type: "tool_result",
        tool_use_id: id,
        content: `Task #${taskId} created successfully: ${subject}`,
      },
    ],
  },
  tool_use_result: { task: { id: taskId, subject } },
});
const taskUpdate = (id: string, taskId: string, status: string) => ({
  type: "assistant",
  parent_tool_use_id: null,
  message: {
    content: [{ type: "tool_use", id, name: "TaskUpdate", input: { taskId, status } }],
  },
});
const taskUpdated = (id: string, taskId: string) => ({
  type: "user",
  parent_tool_use_id: null,
  message: {
    content: [{ type: "tool_result", tool_use_id: id, content: `Updated task #${taskId} status` }],
  },
});

describe("Claude CLI Task progress card (F45, F60)", () => {
  it("fills the session card from TaskCreate and TaskUpdate", async () => {
    const runId = "cli-claude-task-card";
    const handlers = createHandlers(runId);
    const plans: Array<Record<string, unknown>> = [];
    const dispose = onAgentEvent((event) => {
      if (event.runId === runId && event.stream === "plan") {
        plans.push(event.data);
      }
    });
    try {
      const observer = createClaudeCliTodoObserver({
        stateKey: "claude-session-1",
        onChange: handlers.emitCliTodos,
      });
      observer.observe(taskCreate("c1", "Read the logs"));
      observer.observe(taskCreated("c1", "1", "Read the logs"));
      observer.observe(taskCreate("c2", "Fix the bug"));
      observer.observe(taskCreated("c2", "2", "Fix the bug"));
      observer.observe(taskUpdate("u1", "1", "completed"));
      observer.observe(taskUpdated("u1", "1"));
      observer.observe(taskUpdate("u2", "2", "in_progress"));
      observer.observe(taskUpdated("u2", "2"));

      const steps = [
        { step: "Read the logs", status: "completed" },
        { step: "Fix the bug", status: "in_progress" },
      ];
      expect(plans.at(-1)).toMatchObject({
        phase: "update",
        source: "claude-cli",
        steps,
        explanation: "1/2 complete",
      });
      await vi.waitFor(() => {
        expect(callGatewayTool).toHaveBeenLastCalledWith("progressCard.put", expect.any(Object), {
          sessionKey: "agent:main:main",
          agentId: "main",
          plan: steps,
        });
      });
    } finally {
      dispose();
    }
  });
});
