import { describe, expect, it } from "vitest";
import {
  buildFallbackSlashCommands,
  executesInlineImmediately,
  getSlashCommandCompletions,
  mergeClaudeSlashCommands,
  parseSlashCommand,
  replaceSlashCommands,
  type SlashCommandDef,
} from "./commands.ts";

describe("mergeClaudeSlashCommands", () => {
  const base: SlashCommandDef[] = [
    { key: "compact", name: "compact", description: "Compact", aliases: ["/squash"] },
    { key: "skill:lint", name: "lint", description: "Lint skill", source: "skill" },
  ];

  it("appends Claude commands after OpenClaw's and lets OpenClaw names win", () => {
    const merged = mergeClaudeSlashCommands(base, [
      { name: "compact", kind: "command" },
      { name: "squash", kind: "command" },
      { name: "LINT", kind: "skill" },
      { name: "review", kind: "command" },
      { name: "example-skill", kind: "skill" },
      { name: "tools:format", kind: "command" },
      { name: "review", kind: "command" },
      { name: "bad name", kind: "command" },
    ]);
    expect(merged.slice(0, 2)).toEqual(base);
    expect(
      merged.slice(2).map((command) => [command.name, command.source, command.claudeKind]),
    ).toEqual([
      ["review", "claude", "command"],
      ["example-skill", "claude", "skill"],
      ["tools:format", "claude", "command"],
    ]);
    expect(merged[2]).toMatchObject({
      executeLocal: false,
      descriptionKey: "chat.commands.claudeDescription",
    });
  });

  it("keeps the base list without Claude entries", () => {
    expect(mergeClaudeSlashCommands(base, undefined)).toEqual(base);
  });
});

describe("Claude commands in completions", () => {
  it("are offered at the start of a message, sent as text, and never run inline", () => {
    const merged = mergeClaudeSlashCommands(buildFallbackSlashCommands(), [
      { name: "example-review", kind: "command" },
    ]);
    replaceSlashCommands(merged);
    try {
      const command = merged.find((entry) => entry.name === "example-review");
      expect(command && executesInlineImmediately(command)).toBe(false);
      expect(getSlashCommandCompletions("example-rev").map((entry) => entry.name)).toEqual([
        "example-review",
      ]);
      expect(
        getSlashCommandCompletions("example-rev", { inlineOnly: true }).map((entry) => entry.name),
      ).toEqual([]);
      expect(parseSlashCommand("/example-review src")?.command).toMatchObject({
        source: "claude",
        executeLocal: false,
      });
    } finally {
      replaceSlashCommands(buildFallbackSlashCommands());
    }
  });
});
