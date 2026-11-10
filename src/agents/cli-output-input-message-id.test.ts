import { describe, expect, it } from "vitest";
import { parseCliOutput } from "./cli-output.js";
import { joinJsonlFrames } from "./cli-output.test-helpers.js";

function parseClaude(raw: string) {
  return parseCliOutput({
    raw,
    backend: { command: "claude", output: "jsonl", sessionIdFields: ["session_id"] },
    providerId: "claude-cli",
    outputMode: "jsonl",
  });
}

describe("Claude CLI input message id (F52)", () => {
  it("reads the input uuid the Claude runtime puts on the turn result", () => {
    const output = parseClaude(
      joinJsonlFrames(
        { type: "system", subtype: "init", session_id: "native-session" },
        {
          type: "assistant",
          uuid: "assistant-checkpoint",
          message: {
            id: "message-1",
            role: "assistant",
            content: [{ type: "text", text: "done" }],
          },
        },
        {
          type: "result",
          session_id: "native-session",
          result: "done",
          openclaw_input_uuid: "native-user-uuid",
        },
      ),
    );
    expect(output).toMatchObject({
      resumeCheckpointId: "assistant-checkpoint",
      inputMessageId: "native-user-uuid",
    });
  });

  it("leaves results without the tag alone", () => {
    const output = parseClaude(
      joinJsonlFrames(
        { type: "system", subtype: "init", session_id: "native-session" },
        { type: "result", session_id: "native-session", result: "done" },
      ),
    );
    expect(output).not.toHaveProperty("inputMessageId");
  });
});
