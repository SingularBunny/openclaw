// Fork (F60): Claude's own todo list in agent turns.
//
// Claude Code 2.1.302 enables TodoWrite and the Task* tools (TaskCreate, TaskUpdate,
// TaskList, TaskGet) only for an allowlist of older models (Opus 4.x, Sonnet 4.x,
// Haiku 4.5 and earlier). For any other model, such as claude-opus-5-5, they are on
// only when CLAUDE_CODE_ENABLE_TODO_TOOLS is truthy or when `--tools`/`--allowedTools`
// names one of them. With CLAUDE_CODE_ENABLE_TASKS unset, the Task* tools win over
// TodoWrite. They keep a local task list and touch nothing on the host, and none of
// them maps to an OpenClaw capability, so F45 can show the list as the Task progress card.

/** Claude Code's todo tools; the CLI exposes either TodoWrite or the Task* set. */
export const CLAUDE_CLI_TODO_TOOL_NAMES = [
  "TodoWrite",
  "TaskCreate",
  "TaskUpdate",
  "TaskList",
  "TaskGet",
] as const;

/** Lifts Claude Code's model allowlist for the todo tools (agent runs only). */
export const CLAUDE_CLI_TODO_TOOLS_ENV = {
  CLAUDE_CODE_ENABLE_TODO_TOOLS: "true",
} as const;

/**
 * Adds the todo tools to an explicit native tool list. An empty list means the run
 * has native tools disabled and stays empty; Claude's `default` preset already
 * includes every tool and must stay a single word to keep its meaning.
 */
export function withClaudeCliTodoTools(tools: readonly string[]): string[] {
  if (tools.length === 0 || (tools.length === 1 && tools[0]?.toLowerCase() === "default")) {
    return [...tools];
  }
  return [...new Set([...tools, ...CLAUDE_CLI_TODO_TOOL_NAMES])];
}
