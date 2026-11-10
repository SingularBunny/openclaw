import type { CliBackendExecuteContext } from "openclaw/plugin-sdk/cli-backend";
import { describe, expect, it } from "vitest";
import { buildAnthropicCliBackend } from "./cli-backend.js";
import { prepareClaudeCliTransportArgs } from "./cli-runtime-args.js";
import { resolveClaudeCliExecutionArgs } from "./cli-shared.js";
import { CLAUDE_CLI_TODO_TOOL_NAMES, withClaudeCliTodoTools } from "./cli-todo-tools.js";

const TODO_TOOLS = [...CLAUDE_CLI_TODO_TOOL_NAMES];

function transportContext(
  overrides: Partial<CliBackendExecuteContext> = {},
): CliBackendExecuteContext {
  return {
    command: "claude",
    args: ["-p", "--allowedTools", "mcp__openclaw__*"],
    cwd: "/tmp",
    env: {},
    prompt: "hi",
    modelId: "claude-opus-5-5",
    systemPrompt: "system",
    useResume: false,
    timeoutMs: 1_000,
    ...overrides,
  };
}

function flagValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
}

describe("Claude CLI todo tools (F60)", () => {
  it("adds the todo tools to an explicit native tool list only", () => {
    expect(withClaudeCliTodoTools(["Read", "Bash"])).toEqual(["Read", "Bash", ...TODO_TOOLS]);
    expect(withClaudeCliTodoTools(["TodoWrite", "Read"])).toEqual([
      "TodoWrite",
      "Read",
      "TaskCreate",
      "TaskUpdate",
      "TaskList",
      "TaskGet",
    ]);
    expect(withClaudeCliTodoTools([])).toEqual([]);
    expect(withClaudeCliTodoTools(["default"])).toEqual(["default"]);
  });

  it("keeps the todo tools in --tools when the run selects native tools", () => {
    const { args } = prepareClaudeCliTransportArgs(
      transportContext({ toolAvailability: { native: ["Read", "Edit"], openClaw: ["message"] } }),
    );
    expect(flagValue(args, "--tools")?.split(",")).toEqual(["Read", "Edit", ...TODO_TOOLS]);
    // No OpenClaw capability or automatic approval comes with them.
    expect(flagValue(args, "--allowedTools")).toBe("mcp__openclaw__message");
  });

  it("keeps the todo tools next to a configured --tools list", () => {
    const { args } = prepareClaudeCliTransportArgs(
      transportContext({ args: ["-p", "--tools", "Read,Grep"] }),
    );
    expect(flagValue(args, "--tools")?.split(",")).toEqual(["Read", "Grep", ...TODO_TOOLS]);
  });

  it("leaves a run without native tools without todo tools", () => {
    const { args } = prepareClaudeCliTransportArgs(
      transportContext({ toolAvailability: { native: [], openClaw: ["message"] } }),
    );
    expect(flagValue(args, "--tools")).toBe("");
  });

  it("does not add --tools when the run keeps Claude's default tool set", () => {
    const { args } = prepareClaudeCliTransportArgs(transportContext());
    expect(args).not.toContain("--tools");
  });

  it("projects the todo tools into restricted execution args but not side questions", () => {
    const base = {
      workspaceDir: "/tmp",
      provider: "claude-cli",
      modelId: "claude-opus-5-5",
      useResume: false,
      baseArgs: ["-p"],
    };
    const agent = resolveClaudeCliExecutionArgs({
      ...base,
      toolAvailability: { native: ["Read"], openClaw: [] },
    });
    expect(flagValue(agent, "--tools")?.split(",")).toEqual(["Read", ...TODO_TOOLS]);
    const disabled = resolveClaudeCliExecutionArgs({
      ...base,
      toolAvailability: { native: [], openClaw: [] },
    });
    expect(flagValue(disabled, "--tools")).toBe("");
    const sideQuestion = resolveClaudeCliExecutionArgs({
      ...base,
      executionMode: "side-question",
      toolAvailability: { native: ["Read"], openClaw: [] },
    });
    expect(flagValue(sideQuestion, "--tools")).toBe("Read");
  });

  it("lifts Claude's model allowlist for agent runs only", () => {
    const backend = buildAnthropicCliBackend();
    const prepare = (extra: Record<string, unknown>) =>
      backend.prepareExecution?.({
        workspaceDir: "/tmp/openclaw-claude-cli",
        provider: "claude-cli",
        modelId: "claude-opus-5-5",
        ...extra,
      } as never) as { env?: Record<string, string> };
    expect(prepare({}).env).toMatchObject({ CLAUDE_CODE_ENABLE_TODO_TOOLS: "true" });
    expect(prepare({ executionMode: "agent" }).env).toMatchObject({
      CLAUDE_CODE_ENABLE_TODO_TOOLS: "true",
    });
    expect(prepare({ executionMode: "side-question" }).env).not.toHaveProperty(
      "CLAUDE_CODE_ENABLE_TODO_TOOLS",
    );
    expect(
      prepare({
        isolatedCompletionPrompt: "side question",
        isolatedCompletionSystemPrompt: "side system",
      }).env,
    ).not.toHaveProperty("CLAUDE_CODE_ENABLE_TODO_TOOLS");
  });
});
