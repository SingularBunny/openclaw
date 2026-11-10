import { describe, expect, it } from "vitest";
import { createClaudeParser, joinJsonlFrames } from "./cli-output.test-helpers.js";

describe("Claude init slash commands", () => {
  it("reports the parent session's commands and skills, not a subagent's", () => {
    const reported: unknown[] = [];
    const parser = createClaudeParser({ onNativeCommands: (commands) => reported.push(commands) });
    parser.push(
      joinJsonlFrames(
        {
          type: "system",
          subtype: "init",
          session_id: "s",
          tools: ["Read"],
          slash_commands: ["compact", "example-skill"],
          skills: ["example-skill"],
        },
        {
          type: "system",
          subtype: "init",
          session_id: "s",
          parent_tool_use_id: "toolu_1",
          slash_commands: ["subagent-only"],
        },
        { type: "system", subtype: "init", session_id: "s", tools: [] },
        "",
      ),
    );
    parser.finish();
    expect(reported).toEqual([
      [
        { name: "compact", kind: "command" },
        { name: "example-skill", kind: "skill" },
      ],
    ]);
  });

  it("keeps parsing when the sink throws", () => {
    const parser = createClaudeParser({
      onNativeCommands: () => {
        throw new Error("sink failed");
      },
    });
    parser.push(
      joinJsonlFrames(
        { type: "system", subtype: "init", session_id: "s", slash_commands: ["compact"] },
        { type: "result", result: "Done." },
        "",
      ),
    );
    expect(() => parser.finish()).not.toThrow();
  });
});
