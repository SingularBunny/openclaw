// @vitest-environment node
import { describe, expect, it } from "vitest";
import { lastOtherReplyAnswerer } from "./chat-reply-authors.ts";
import {
  publishAcpAgentIdentities,
  publishReplyModelLabeler,
  resolveReplyIdentity,
} from "./chat-reply-identity.ts";
import { groupMessages } from "./chat-thread-grouping.ts";
import { resolveMessageGroupSenderLabel } from "./components/chat-message-sender.ts";

function reply(text: string, provider: string, model: string, extra: object = {}) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    provider,
    model,
    timestamp: 1,
    ...extra,
  };
}

describe("reply identity", () => {
  it("names an ACP agent by its configured identity, else its id, with its own avatar id", () => {
    expect(resolveReplyIdentity([{ message: reply("hi", "acp", "codex") }])).toEqual({
      kind: "agent",
      agent: "codex",
      avatarId: "acp:codex",
      name: "Codex",
      avatar: null,
      textAvatar: null,
    });
    publishAcpAgentIdentities({ junie: { name: "Junie", emoji: "🧩" } });
    expect(resolveReplyIdentity([{ message: reply("hi", "acp", "junie") }])).toMatchObject({
      name: "Junie",
      textAvatar: "🧩",
    });
    // A gateway row that names its ACP agent for display only.
    const gatewayRow = reply("hi", "openclaw", "gateway-injected", {
      __openclaw: { author: { provider: "acp", model: "junie" } },
    });
    expect(resolveReplyIdentity([{ message: gatewayRow }])?.name).toBe("Junie");
    expect(resolveReplyIdentity([{ message: reply("hi", "openclaw", "gateway-injected") }])).toBe(
      undefined,
    );
  });

  it("names a model reply by the picker label and the sender on hover by its real author", () => {
    publishReplyModelLabeler((model) => (model === "openrouter/cohere/c:free" ? "Cohere" : ""));
    const group = {
      role: "assistant",
      senderLabel: null,
      messages: [{ message: reply("ok", "openrouter", "cohere/c:free") }],
    };
    expect(resolveMessageGroupSenderLabel(group, { assistantName: "Claude" })).toBe("Cohere");
    const acp = { ...group, messages: [{ message: reply("ok", "acp", "junie") }] };
    expect(resolveMessageGroupSenderLabel(acp, { assistantName: "Claude" })).toBe("Junie");
    // Forwarded rows keep their own attribution; unauthored rows keep the chat agent.
    const forwarded = { ...acp, senderSession: { sessionKey: "agent:ops:main", agentId: "ops" } };
    expect(resolveMessageGroupSenderLabel(forwarded, { assistantName: "Claude" })).toBe("Claude");
    const plain = { ...group, messages: [{ message: { role: "assistant", content: "x" } }] };
    expect(resolveMessageGroupSenderLabel(plain, { assistantName: "Claude" })).toBe("Claude");
  });

  it("never puts replies of two authors in one group", () => {
    const messages = [
      reply("one", "acp", "junie"),
      reply("two", "openrouter", "cohere/c:free"),
      reply("three", "openrouter", "cohere/c:free"),
    ];
    const groups = groupMessages(
      messages.map((message, index) => ({ kind: "message", key: `m${index}`, message })),
    );
    expect(groups.map((group) => (group.kind === "group" ? group.messages.length : 0))).toEqual([
      1, 2,
    ]);
  });

  it("shows a group chat member's reply under the member, apart from the chat's answerer (fork)", () => {
    const member = (kind: string, id: string, name: string) => ({
      __openclaw: { participant: { kind, id, key: `${kind}:${id}`, name } },
    });
    const agentRow = reply(
      "Prune in winter",
      "ollama",
      "qwen3",
      member("agent", "garden", "Gardener"),
    );
    expect(resolveReplyIdentity([{ message: agentRow }])).toEqual({
      kind: "agent",
      agent: "garden",
      avatarId: "garden",
      name: "Gardener",
      avatar: null,
      textAvatar: null,
    });
    const modelRow = reply(
      "Hi",
      "openrouter",
      "google/gemma:free",
      member("model", "openrouter/google/gemma:free", "Gemma"),
    );
    expect(resolveReplyIdentity([{ message: modelRow }])).toMatchObject({
      kind: "model",
      name: "Gemma",
    });
    const acpRow = reply("Reviewed", "acp", "junie", member("acp", "junie", "Junie"));
    expect(resolveReplyIdentity([{ message: acpRow }])).toMatchObject({ avatarId: "acp:junie" });
    const group = { role: "assistant", senderLabel: null, messages: [{ message: agentRow }] };
    expect(resolveMessageGroupSenderLabel(group, { assistantName: "Claude" })).toBe("Gardener");

    // Members never become the chat's answerer to return to; two members never share a block.
    const opus = reply("Plan", "anthropic", "claude-opus-4-6");
    expect(
      lastOtherReplyAnswerer([opus, acpRow, modelRow], { kind: "model", model: "openrouter/x" }),
    ).toEqual({
      kind: "model",
      model: "anthropic/claude-opus-4-6",
    });
    const sameModel = reply("Also", "ollama", "qwen3", member("agent", "orchard", "Orchard"));
    const groups = groupMessages(
      [opus, agentRow, sameModel].map((message, index) => ({
        kind: "message",
        key: `g${index}`,
        message,
      })),
    );
    expect(groups.filter((entry) => entry.kind === "group")).toHaveLength(3);
  });
});
