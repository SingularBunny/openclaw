import { afterEach, describe, expect, it } from "vitest";
import {
  CLAUDE_NATIVE_COMMANDS_MAX,
  readClaudeInitCommands,
  readClaudeNativeCommands,
  recordClaudeNativeCommands,
  resetClaudeNativeCommandsForTest,
} from "./claude-native-commands.js";

afterEach(() => {
  resetClaudeNativeCommandsForTest();
});

describe("readClaudeInitCommands", () => {
  it("reads slash commands and marks skills, without duplicates", () => {
    expect(
      readClaudeInitCommands({
        type: "system",
        subtype: "init",
        slash_commands: ["compact", "/review", "example-skill", "tools:lint", "Review"],
        skills: ["example-skill", { name: "other-skill" }],
      }),
    ).toEqual([
      { name: "compact", kind: "command" },
      { name: "review", kind: "command" },
      { name: "example-skill", kind: "skill" },
      { name: "tools:lint", kind: "command" },
      { name: "other-skill", kind: "skill" },
    ]);
  });

  it("drops names Claude could not run as a slash command", () => {
    expect(
      readClaudeInitCommands({
        slash_commands: ["two words", "a/b", "", 7, null, "-dash", "x".repeat(201), "ok.name"],
      }),
    ).toEqual([{ name: "ok.name", kind: "command" }]);
  });

  it("returns undefined when the record has neither list", () => {
    expect(readClaudeInitCommands({ type: "system", subtype: "init", tools: [] })).toBeUndefined();
  });

  it("bounds the list", () => {
    const names = Array.from({ length: CLAUDE_NATIVE_COMMANDS_MAX + 20 }, (_, i) => `c${i}`);
    expect(readClaudeInitCommands({ slash_commands: names })).toHaveLength(
      CLAUDE_NATIVE_COMMANDS_MAX,
    );
  });
});

describe("Claude native command cache", () => {
  const commands = [{ name: "review", kind: "command" as const }];

  it("keeps the session list and offers the agent's latest to other sessions on request", () => {
    expect(recordClaudeNativeCommands({ sessionId: "s1", agentId: "main", commands, now: 5 })).toBe(
      true,
    );
    expect(readClaudeNativeCommands({ sessionId: "s1", agentId: "main" })).toEqual({
      commands,
      capturedAt: 5,
    });
    expect(readClaudeNativeCommands({ sessionId: "s2", agentId: "main" })).toBeUndefined();
    expect(
      readClaudeNativeCommands({ sessionId: "s2", agentId: "main", agentFallback: true }),
    ).toEqual({ commands, capturedAt: 5, fromAgent: true });
    expect(
      readClaudeNativeCommands({ sessionId: "s2", agentId: "other", agentFallback: true }),
    ).toBeUndefined();
  });

  it("ignores empty lists so a restricted run does not clear the session's list", () => {
    recordClaudeNativeCommands({ sessionId: "s1", commands, now: 1 });
    expect(recordClaudeNativeCommands({ sessionId: "s1", commands: [], now: 2 })).toBe(false);
    expect(readClaudeNativeCommands({ sessionId: "s1" })?.capturedAt).toBe(1);
  });
});
