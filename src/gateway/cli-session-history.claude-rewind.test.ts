import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { resolveClaudeCliRewindPoint } from "./cli-session-history.claude-rewind.js";
import { withClaudeProjectsDir } from "./cli-session-history.test-support.js";

type Row = {
  uuid: string;
  parentUuid: string | null;
  type: string;
  content?: unknown;
  isSidechain?: boolean;
};

function lines(rows: Row[]): string {
  return rows
    .map((row, index) =>
      JSON.stringify({
        parentUuid: row.parentUuid,
        isSidechain: row.isSidechain === true,
        type: row.type,
        ...(row.content === undefined ? {} : { message: { role: row.type, content: row.content } }),
        uuid: row.uuid,
        timestamp: new Date(Date.parse("2026-11-05T10:00:00.000Z") + index * 1000).toISOString(),
      }),
    )
    .join("\n");
}

// u1 -> a1(tool_use) -> r1(tool_result) -> a1b(text) -> s1(system) -> u2 -> a2 -> u3 -> a3
const transcript: Row[] = [
  { uuid: "u1", parentUuid: null, type: "user", content: "first question" },
  { uuid: "a1", parentUuid: "u1", type: "assistant", content: [{ type: "tool_use" }] },
  {
    uuid: "r1",
    parentUuid: "a1",
    type: "user",
    content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
  },
  { uuid: "a1b", parentUuid: "r1", type: "assistant", content: [{ type: "text", text: "one" }] },
  { uuid: "s1", parentUuid: "a1b", type: "system" },
  { uuid: "side", parentUuid: "a1b", type: "assistant", isSidechain: true, content: "side" },
  {
    uuid: "u2",
    parentUuid: "s1",
    type: "user",
    content: [{ type: "text", text: "Typed in Claude Code" }],
  },
  { uuid: "a2", parentUuid: "u2", type: "assistant", content: [{ type: "text", text: "two" }] },
  { uuid: "u3", parentUuid: "a2", type: "user", content: "third question" },
  { uuid: "a3", parentUuid: "u3", type: "assistant", content: [{ type: "text", text: "three" }] },
];

describe("Claude CLI rewind points", () => {
  it("resumes at the last assistant row on the prompt's chain", async () => {
    await withClaudeProjectsDir(async ({ homeDir, sessionId, filePath }) => {
      await fs.writeFile(filePath, lines(transcript), "utf8");
      const resolve = (messageId: string) =>
        resolveClaudeCliRewindPoint({ cliSessionId: sessionId, homeDir, messageId });

      await expect(resolve("u2")).resolves.toEqual({
        prompt: true,
        checkpointId: "a1b",
        editorText: "Typed in Claude Code",
      });
      await expect(resolve("u3")).resolves.toEqual({
        prompt: true,
        checkpointId: "a2",
        editorText: "third question",
      });
      // The first prompt has nothing to resume at: the next turn starts a fresh native session.
      await expect(resolve("u1")).resolves.toEqual({ prompt: true, editorText: "first question" });
      await expect(resolve("r1")).resolves.toEqual({ prompt: false, checkpointId: "a1" });
      await expect(resolve("missing")).resolves.toBeUndefined();
      await expect(
        resolveClaudeCliRewindPoint({ cliSessionId: "other", homeDir, messageId: "u2" }),
      ).resolves.toBeUndefined();
    });
  });

  it("drops the OpenClaw context that the Gateway adds to CLI prompts", async () => {
    await withClaudeProjectsDir(async ({ homeDir, sessionId, filePath }) => {
      const decorated = [
        "Conversation info: ⟦openclaw:ctx⟧",
        "```json",
        '{"requester_profile":{"id":"gateway-owner"}}',
        "```",
        "",
        "Rewind me",
      ].join("\n");
      await fs.writeFile(
        filePath,
        lines([
          { uuid: "a0", parentUuid: null, type: "assistant", content: "hi" },
          { uuid: "u1", parentUuid: "a0", type: "user", content: decorated },
        ]),
        "utf8",
      );

      await expect(
        resolveClaudeCliRewindPoint({ cliSessionId: sessionId, homeDir, messageId: "u1" }),
      ).resolves.toEqual({ prompt: true, checkpointId: "a0", editorText: "Rewind me" });
    });
  });
});

describe("Claude CLI history after a rewind", () => {
  it("hides rows after the checkpoint that the next turn resumes at", async () => {
    await withClaudeProjectsDir(async ({ filePath, readMessages }) => {
      await fs.writeFile(filePath, lines(transcript), "utf8");
      const ids = (messages: Record<string, unknown>[]) =>
        messages.map(
          (message) => (message["__openclaw"] as { externalId?: string } | undefined)?.externalId,
        );

      const full = ids(await readMessages());
      expect(full).toContain("u3");
      const cut = ids(await readMessages({ resumeAtCheckpointId: "a2" }));
      expect(cut).toContain("u2");
      expect(cut).not.toContain("u3");
      expect(cut).not.toContain("a3");
      // An unknown checkpoint keeps the whole native transcript visible.
      expect(ids(await readMessages({ resumeAtCheckpointId: "gone" }))).toEqual(full);
    });
  });
});
