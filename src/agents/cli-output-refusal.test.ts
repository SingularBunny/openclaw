import { describe, expect, it } from "vitest";
import { parseCliOutput } from "./cli-output.js";
import { joinJsonlFrames } from "./cli-output.test-helpers.js";

function parseClaude(result: Record<string, unknown>) {
  return parseCliOutput({
    raw: joinJsonlFrames(
      { type: "system", subtype: "init", session_id: "native-session" },
      {
        type: "assistant",
        uuid: "assistant-checkpoint",
        message: {
          id: "message-1",
          role: "assistant",
          content: [{ type: "text", text: "I can't help with that." }],
        },
      },
      {
        type: "result",
        session_id: "native-session",
        subtype: "success",
        result: "I can't help with that.",
        ...result,
      },
    ),
    backend: { command: "claude", output: "jsonl", sessionIdFields: ["session_id"] },
    providerId: "claude-cli",
    outputMode: "jsonl",
  });
}

describe("Claude CLI refusal stop reason (I14)", () => {
  it("records the API refusal with its category and keeps the reply", () => {
    const output = parseClaude({ stop_reason: "refusal", stop_details: { category: "cyber" } });
    expect(output?.refusal).toEqual({ category: "cyber" });
    expect(output?.text).toBe("I can't help with that.");
    expect(parseClaude({ stop_reason: "refusal" })?.refusal).toEqual({});
  });

  it("ignores other stop reasons and unsafe categories", () => {
    expect(parseClaude({ stop_reason: "end_turn" })?.refusal).toBeUndefined();
    expect(
      parseClaude({ stop_reason: "refusal", stop_details: { category: "x y" } })?.refusal,
    ).toEqual({});
  });
});
