import { describe, expect, it } from "vitest";
import { stripThinkingTags } from "../../../lib/strip-thinking-tags.ts";
import {
  prepareChatMessageRender,
  resolveMessageActionDetails,
  resolveRefusalHint,
} from "./chat-message-markdown-view.tsx";

const reply = (text: string, extra: Record<string, unknown> = {}) => ({
  role: "assistant",
  content: [{ type: "text", text }],
  ...extra,
});

describe("refusal hint signal (I14)", () => {
  it("prefers the API signal, then the model's marker, then a phrase", () => {
    expect(
      resolveRefusalHint(reply("No.", { __openclaw: { refusal: { signal: "provider" } } }), "No."),
    ).toEqual({ refusal: "provider" });
    expect(
      resolveRefusalHint(reply("I can't help with that.\n<!-- openclaw:refusal -->"), ""),
    ).toEqual({ refusal: "marker" });
    expect(resolveRefusalHint(reply("x"), "I can't help with that.")).toEqual({
      refusal: "phrase",
    });
    expect(resolveRefusalHint(reply("x"), "Here you go.")).toEqual({});
  });

  it("shows no hint once the turn was handed off", () => {
    const handedOff = reply("No.", {
      __openclaw: { refusal: { signal: "provider" }, refusalHandoff: { signal: "provider" } },
    });
    expect(resolveRefusalHint(handedOff, "I can't help with that.")).toEqual({});
  });

  it("hides the marker in the shown and copied text and puts the signal on the reply's actions", () => {
    expect(stripThinkingTags("I won't.\n<!-- openclaw:refusal -->")).toBe("I won't.\n");
    const message = reply("I won't write that.\n<!-- openclaw:refusal -->", {
      __openclaw: { id: "a1" },
    });
    const details = resolveMessageActionDetails(prepareChatMessageRender(message), {
      messageId: "a1",
      senderLabel: "Assistant",
      sessionKey: "agent:main:main",
    });
    expect(details?.markdown).not.toContain("openclaw:refusal");
    expect(details?.handoff).toMatchObject({ messageKey: "a1", refusal: "marker" });
  });
});
