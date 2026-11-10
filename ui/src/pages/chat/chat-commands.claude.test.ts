// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { SLASH_COMMANDS } from "../../lib/chat/commands.ts";
import { applyRemoteSlashCommandsResult, refreshSlashCommands } from "./chat-commands.ts";

function clientWith(methods: string[], claude: unknown) {
  const request = vi.fn(async (method: string) =>
    method === "commands.claude"
      ? claude
      : {
          commands: [
            {
              name: "notes",
              textAliases: ["/notes"],
              description: "Notes",
              source: "plugin",
              scope: "text",
              acceptsArgs: false,
            },
          ],
        },
  );
  return { request, hello: { features: { methods } } };
}

function claudeNames() {
  return SLASH_COMMANDS.filter((command) => command.source === "claude").map(
    (command) => command.name,
  );
}

describe("Claude CLI commands in slash refresh", () => {
  it("adds the session's Claude commands and keeps them across metadata updates", async () => {
    const client = clientWith(["commands.list", "commands.claude"], {
      commands: [
        { name: "example-review", kind: "command" },
        { name: "compact", kind: "command" },
        { name: "example-skill", kind: "skill" },
      ],
      capturedAt: 1,
    });
    try {
      await refreshSlashCommands({
        client: client as never,
        agentId: "main",
        sessionKey: "agent:main:claude-a",
      });
      expect(client.request).toHaveBeenCalledWith("commands.claude", {
        sessionKey: "agent:main:claude-a",
        agentId: "main",
      });
      expect(claudeNames()).toEqual(["example-review", "example-skill"]);
      expect(applyRemoteSlashCommandsResult({ commands: [] })).toBe(true);
      expect(claudeNames()).toEqual(["example-review", "example-skill"]);
    } finally {
      await refreshSlashCommands({ client: null });
    }
    expect(claudeNames()).toEqual([]);
  });

  it("does not ask a Gateway that does not list commands.claude", async () => {
    const client = clientWith(["commands.list"], { commands: [] });
    try {
      await refreshSlashCommands({
        client: client as never,
        agentId: "main",
        sessionKey: "agent:main:claude-b",
      });
      expect(client.request.mock.calls.map(([method]) => method)).toEqual(["commands.list"]);
    } finally {
      await refreshSlashCommands({ client: null });
    }
  });
});
