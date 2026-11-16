import { describe, expect, it } from "vitest";
import { projectChatDisplayMessages } from "./chat-display-projection.js";

describe("refusal signal in chat history (I14)", () => {
  it("names a provider refusal on the shown row although the diagnostics stay private", () => {
    const [row] = projectChatDisplayMessages([
      {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "Anthropic refusal (category: cyber).",
        diagnostics: [
          {
            type: "provider_refusal",
            timestamp: 1,
            details: { provider: "anthropic", category: "cyber" },
          },
        ],
        __openclaw: { id: "a1" },
      },
    ]);
    expect(row?.diagnostics).toBeUndefined();
    expect(row?.["__openclaw"]).toMatchObject({
      id: "a1",
      refusal: { signal: "provider", category: "cyber" },
    });
    expect(JSON.stringify(row?.content)).toContain("The provider refused this request");
  });

  it("strips the model's marker and names it", () => {
    const [row] = projectChatDisplayMessages([
      {
        role: "assistant",
        content: [{ type: "text", text: "I won't write that.\n<!-- openclaw:refusal -->" }],
        stopReason: "stop",
        __openclaw: { id: "a2" },
      },
    ]);
    expect(row?.["__openclaw"]).toMatchObject({ refusal: { signal: "marker" } });
    expect(JSON.stringify(row?.content)).not.toContain("openclaw:refusal");
    expect(JSON.stringify(row?.content)).toContain("I won't write that.");
  });

  it("leaves ordinary replies as they were", () => {
    const [row] = projectChatDisplayMessages([
      { role: "assistant", content: [{ type: "text", text: "Done." }], stopReason: "stop" },
    ]);
    expect(row?.["__openclaw"]).toBeUndefined();
  });
});
