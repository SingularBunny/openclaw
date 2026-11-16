import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveBoundAcpReplyAuthor } from "./chat-send-bound-acp-reply.js";

const transcript = {
  agentId: "main",
  sessionId: "child-session",
  sessionKey: "agent:main:acp:child",
  storePath: "/tmp/store",
  messageId: "m1",
  idempotencyKey: "run-1",
  acpAgent: "codex",
};
const enabled = { acp: { seedParentHistory: true } } as OpenClawConfig;

describe("bound ACP reply author (F72)", () => {
  it("marks a bound ACP reply as ACP output only when the chat shares its history", () => {
    expect(resolveBoundAcpReplyAuthor(enabled, "agent:main:main", transcript)).toEqual({
      runtimeAuthor: { provider: "acp", model: "codex" },
    });
    expect(resolveBoundAcpReplyAuthor({}, "agent:main:main", transcript)).toEqual({});
    // An unbound ACP session owns its own transcript row.
    expect(resolveBoundAcpReplyAuthor(enabled, transcript.sessionKey, transcript)).toEqual({});
    expect(resolveBoundAcpReplyAuthor(enabled, "agent:main:main", undefined)).toEqual({});
  });

  it("carries an ACP agent's refusal to the chat row (I14)", () => {
    const refused = { ...transcript, refusal: true as const };
    expect(resolveBoundAcpReplyAuthor(enabled, "agent:main:main", refused)).toEqual({
      runtimeAuthor: { provider: "acp", model: "codex" },
      refusal: true,
    });
    // Without shared history the mirrored row is not replayed, but the hint still shows.
    expect(resolveBoundAcpReplyAuthor({}, "agent:main:main", refused)).toEqual({ refusal: true });
  });
});
