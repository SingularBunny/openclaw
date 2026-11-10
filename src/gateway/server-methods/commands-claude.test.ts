import { Value } from "typebox/value";
import { afterEach, describe, expect, it } from "vitest";
import {
  CommandsClaudeParamsSchema,
  CommandsClaudeResultSchema,
} from "../../../packages/gateway-protocol/src/schema/commands.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import {
  recordClaudeNativeCommands,
  resetClaudeNativeCommandsForTest,
} from "../../infra/claude-native-commands.js";
import { buildClaudeCommandsResult } from "./commands.js";

afterEach(() => {
  resetClaudeNativeCommandsForTest();
});

function entry(fields: Partial<SessionEntry>): SessionEntry {
  return { sessionId: "session-a", updatedAt: 1, ...fields } as SessionEntry;
}

describe("commands.claude", () => {
  const commands = [
    { name: "review", kind: "command" as const },
    { name: "example-skill", kind: "skill" as const },
  ];

  it("returns the session's own Claude commands", () => {
    recordClaudeNativeCommands({ sessionId: "session-a", agentId: "main", commands, now: 10 });
    const result = buildClaudeCommandsResult({ agentId: "main", sessionEntry: entry({}) });
    expect(result).toEqual({ commands, capturedAt: 10 });
    expect(Value.Check(CommandsClaudeResultSchema, result)).toBe(true);
  });

  it("borrows the agent's list for a session without a CLI binding or with a Claude one", () => {
    recordClaudeNativeCommands({ sessionId: "other", agentId: "main", commands, now: 10 });
    expect(
      buildClaudeCommandsResult({ agentId: "main", sessionEntry: entry({ sessionId: "fresh" }) }),
    ).toEqual({ commands, capturedAt: 10, fromAgent: true });
    expect(
      buildClaudeCommandsResult({
        agentId: "main",
        sessionEntry: entry({
          sessionId: "fresh",
          cliSessionBindings: { "claude-cli": { sessionId: "native" } },
        } as Partial<SessionEntry>),
      }).fromAgent,
    ).toBe(true);
  });

  it("does not offer Claude commands to a session bound to another CLI backend", () => {
    recordClaudeNativeCommands({ sessionId: "other", agentId: "main", commands, now: 10 });
    expect(
      buildClaudeCommandsResult({
        agentId: "main",
        sessionEntry: entry({
          sessionId: "fresh",
          cliSessionBindings: { "codex-cli": { sessionId: "native" } },
        } as Partial<SessionEntry>),
      }),
    ).toEqual({ commands: [] });
  });

  it("validates params", () => {
    expect(Value.Check(CommandsClaudeParamsSchema, { sessionKey: "agent:main:main" })).toBe(true);
    expect(Value.Check(CommandsClaudeParamsSchema, {})).toBe(false);
    expect(Value.Check(CommandsClaudeParamsSchema, { sessionKey: "k", extra: 1 })).toBe(false);
  });
});
