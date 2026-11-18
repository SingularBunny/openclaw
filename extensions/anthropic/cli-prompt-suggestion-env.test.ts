import { afterEach, describe, expect, it, vi } from "vitest";
import { buildAnthropicCliBackend } from "./cli-backend.js";
import { resolveClaudeCliPromptSuggestionEnv } from "./cli-shared.js";

const KEY = "CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION";

describe("Claude CLI prompt suggestion env", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("disables Claude Code's unused-suggestion back-off only when suggestions are on", () => {
    expect(resolveClaudeCliPromptSuggestionEnv({}, {})).toEqual({ [KEY]: "1" });
    expect(resolveClaudeCliPromptSuggestionEnv({ executionMode: "agent" }, {})).toEqual({
      [KEY]: "1",
    });
    expect(resolveClaudeCliPromptSuggestionEnv({ executionMode: "side-question" }, {})).toEqual({});
    for (const value of ["0", "false"]) {
      expect(
        resolveClaudeCliPromptSuggestionEnv({}, { OPENCLAW_CLAUDE_PROMPT_SUGGESTIONS: value }),
      ).toEqual({});
    }
  });

  it("puts the env on agent runs of the backend and follows the toggle on use", () => {
    const backend = buildAnthropicCliBackend();
    const prepare = (extra: Record<string, unknown>) =>
      backend.prepareExecution?.({
        workspaceDir: "/tmp/openclaw-claude-cli",
        provider: "claude-cli",
        modelId: "claude-opus-5-5",
        ...extra,
      } as never) as { env?: Record<string, string> };
    vi.stubEnv("OPENCLAW_CLAUDE_PROMPT_SUGGESTIONS", "");
    expect(prepare({ executionMode: "agent" }).env).toMatchObject({ [KEY]: "1" });
    expect(prepare({ executionMode: "side-question" }).env).not.toHaveProperty(KEY);
    expect(
      prepare({ isolatedCompletionPrompt: "q", isolatedCompletionSystemPrompt: "s" }).env,
    ).not.toHaveProperty(KEY);
    vi.stubEnv("OPENCLAW_CLAUDE_PROMPT_SUGGESTIONS", "false");
    expect(prepare({ executionMode: "agent" }).env).not.toHaveProperty(KEY);
  });
});
