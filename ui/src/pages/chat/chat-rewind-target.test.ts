import { describe, expect, it } from "vitest";
import { canCutAtChatMessage, resolveChatMessageCutTarget } from "./chat-rewind-target.ts";

let rawSeq = 0;

function local(
  id: string,
  role: "user" | "assistant",
  meta: Record<string, unknown> = {},
): Record<string, unknown> {
  rawSeq += 1;
  return {
    role,
    content: id,
    __openclaw: {
      id,
      seq: rawSeq,
      transcriptPosition: { source: "local-source", rawSeq },
      ...meta,
    },
  };
}

function imported(id: string, role: "user" | "assistant", content: unknown = id) {
  return {
    role,
    content,
    __openclaw: { id, importedFrom: "claude-cli", cliSessionId: "native", externalId: id },
  };
}

const merged = (externalId: string) => ({ importedFrom: "claude-cli", externalId });
const checkpoint = {
  cliResume: { provider: "claude-cli", sessionId: "native", checkpointId: "c" },
};

describe("rewind targets in Claude CLI chats", () => {
  it("keeps plain OpenClaw rows unchanged", () => {
    const messages = [local("u1", "user"), local("a1", "assistant"), local("u2", "user")];
    expect(resolveChatMessageCutTarget(messages, "u2")).toEqual({ entryId: "u2" });
    expect(resolveChatMessageCutTarget(messages, "unknown")).toEqual({ entryId: "unknown" });
  });

  it("cuts a Claude-only prompt at the next OpenClaw prompt", () => {
    const messages = [
      local("u1", "user"),
      local("a1", "assistant"),
      imported("n1", "user"),
      imported("n2", "assistant"),
      local("u2", "user", merged("n3")),
      local("a2", "assistant", { ...merged("n4"), ...checkpoint }),
    ];
    expect(resolveChatMessageCutTarget(messages, "n1")).toEqual({
      entryId: "u2",
      nativeMessageId: "n1",
      nativeOnly: true,
    });
  });

  it("keeps the OpenClaw branch whole for a Claude-only prompt after it", () => {
    const messages = [local("u1", "user"), local("a1", "assistant"), imported("n1", "user")];
    expect(resolveChatMessageCutTarget(messages, "n1")).toEqual({
      entryId: "n1",
      nativeMessageId: "n1",
      nativeOnly: true,
    });
  });

  it("sends the native row of an OpenClaw prompt whose previous reply has no checkpoint", () => {
    const messages = [
      imported("n1", "user"),
      imported("n2", "assistant"),
      local("u2", "user", merged("n3")),
      local("a2", "assistant", { ...merged("n4"), ...checkpoint }),
      local("u3", "user", merged("n5")),
    ];
    expect(resolveChatMessageCutTarget(messages, "u2")).toEqual({
      entryId: "u2",
      nativeMessageId: "n3",
    });
    // The recorded checkpoint of a2 already says where Claude resumes.
    expect(resolveChatMessageCutTarget(messages, "u3")).toEqual({ entryId: "u3" });
  });

  it("rewinds an unmatched Claude copy together with its OpenClaw prompt", () => {
    const messages = [
      local("u1", "user"),
      local("a1", "assistant", merged("n0")),
      local("u2", "user"),
      imported("n2", "user", "[media attached: x] u2"),
      local("a2", "assistant"),
    ];
    expect(resolveChatMessageCutTarget(messages, "n2")).toEqual({
      entryId: "u2",
      nativeMessageId: "n2",
    });
    expect(resolveChatMessageCutTarget(messages, "u2")).toEqual({
      entryId: "u2",
      nativeMessageId: "n2",
    });
  });

  it("refuses tool results that Claude recorded as user rows", () => {
    const toolResult = imported("r1", "user", [{ type: "tool_result", tool_use_id: "t" }]);
    const messages = [local("u1", "user"), imported("a1", "assistant"), toolResult];
    expect(canCutAtChatMessage(toolResult)).toBe(false);
    expect(canCutAtChatMessage(messages[0])).toBe(true);
    expect(canCutAtChatMessage(imported("n1", "user"))).toBe(true);
    expect(resolveChatMessageCutTarget(messages, "r1")).toBeNull();
  });
});
