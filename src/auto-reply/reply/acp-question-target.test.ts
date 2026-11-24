import { describe, expect, it } from "vitest";
import { resolveAcpQuestionTarget } from "./acp-question-target.js";

const acp = { acpSessionKey: "agent:main:acp:1234", acpAgentId: "main" };

describe("ACP question target", () => {
  it.each([
    ["a bound dashboard chat", "agent:main:catalog-import:abc", "agent:main:catalog-import:abc"],
    [
      "a bound channel conversation",
      "agent:main:telegram:direct:42",
      "agent:main:telegram:direct:42",
    ],
    ["the ACP session itself", "agent:main:acp:1234", "agent:main:acp:1234"],
    ["the ACP session in other case", "AGENT:main:ACP:1234", "agent:main:acp:1234"],
    ["no source", undefined, "agent:main:acp:1234"],
    ["a key naming no agent", "main", "agent:main:acp:1234"],
  ])("asks %s in %s", (_name, sourceSessionKey, expected) => {
    expect(resolveAcpQuestionTarget({ ...acp, sourceSessionKey }).sessionKey).toBe(expected);
  });

  it("names the agent that owns the chat, which can differ from the ACP session's", () => {
    expect(resolveAcpQuestionTarget({ ...acp, sourceSessionKey: "agent:ops:dashboard:7" })).toEqual(
      { sessionKey: "agent:ops:dashboard:7", agentId: "ops" },
    );
  });
});
