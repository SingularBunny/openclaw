import { describe, expect, it } from "vitest";
import {
  lastOtherReplyAnswerer,
  replyAnswerer,
  sameReplyAuthor,
  transcriptNamesAuthors,
} from "./chat-reply-authors.ts";

function reply(provider: string, model: string, extra: Record<string, unknown> = {}) {
  return { role: "assistant", content: [{ type: "text", text: "ok" }], provider, model, ...extra };
}

const catalog = [{ provider: "claude-cli", id: "opus", name: "Claude Opus" }];

describe("chat reply authors", () => {
  it("reads a reply's model or ACP agent and skips failed, empty and Gateway rows", () => {
    expect(replyAnswerer(reply("claude-cli", "opus"), catalog)).toEqual({
      kind: "model",
      model: "claude-cli/opus",
    });
    expect(replyAnswerer(reply("acp", "junie"))).toEqual({ kind: "agent", agent: "junie" });
    expect(replyAnswerer(reply("openrouter", "a/b", { stopReason: "error" }))).toBeUndefined();
    expect(replyAnswerer(reply("openrouter", "a/b", { stopReason: "aborted" }))).toBeUndefined();
    expect(replyAnswerer(reply("openrouter", "a/b", { errorMessage: "429" }))).toBeUndefined();
    expect(replyAnswerer(reply("openrouter", "a/b", { content: [] }))).toBeUndefined();
    expect(replyAnswerer(reply("openclaw", "gateway-injected"))).toBeUndefined();
    expect(
      replyAnswerer({ role: "user", content: "hi", provider: "x", model: "y" }),
    ).toBeUndefined();
  });

  it("treats one model id served by two runtimes as one author, never two ACP agents", () => {
    expect(
      sameReplyAuthor(
        { kind: "model", model: "anthropic/claude-x" },
        { kind: "model", model: "claude-cli/claude-x" },
      ),
    ).toBe(true);
    expect(
      sameReplyAuthor(
        { kind: "model", model: "openrouter/google/gemma" },
        { kind: "model", model: "openrouter/cohere/command" },
      ),
    ).toBe(false);
    expect(
      sameReplyAuthor({ kind: "agent", agent: "junie" }, { kind: "agent", agent: "codex" }),
    ).toBe(false);
    expect(
      sameReplyAuthor({ kind: "agent", agent: "opus" }, { kind: "model", model: "x/opus" }),
    ).toBe(false);
  });

  it("finds the newest other answerer that replied", () => {
    const messages = [
      reply("claude-cli", "opus"),
      reply("acp", "junie"),
      reply("openrouter", "google/gemma", { stopReason: "error" }),
      reply("openrouter", "cohere/command"),
    ];
    const current = { kind: "model", model: "openrouter/cohere/command" } as const;
    expect(lastOtherReplyAnswerer(messages, current, catalog)).toEqual({
      kind: "agent",
      agent: "junie",
    });
    expect(
      lastOtherReplyAnswerer(
        messages.slice(0, 1),
        { kind: "model", model: "claude-cli/opus" },
        catalog,
      ),
    ).toBeUndefined();
    expect(transcriptNamesAuthors(messages)).toBe(true);
    expect(transcriptNamesAuthors([{ role: "assistant", content: "x" }])).toBe(false);
  });
});
