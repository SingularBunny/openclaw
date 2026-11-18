import { expect, it } from "vitest";
import type { MessageGroup } from "../../lib/chat/chat-types.ts";
import { isSessionActivityGroup, readAutomationRun } from "./chat-turn-boundary.ts";

// Fork: the fork's own automation rows were dropped on 2026.11.5 because upstream folds the
// scheduler prompt itself. This pins the history shape that folding relies on.
const cronPrompt = {
  role: "assistant",
  content: [{ type: "text", text: "Write the weekly plan." }],
  senderLabel: "Forwarded from Weekly plan",
  senderSession: { sessionKey: "agent:main:cron:job-1:run:r1", label: "Weekly plan" },
  provenance: {
    kind: "internal_system",
    sourceTool: "cron",
    jobId: "job-1",
    runId: "r1",
    sourceSessionKey: "agent:main:cron:job-1:run:r1",
  },
  timestamp: 1,
};

const group = (message: unknown) =>
  ({
    kind: "group",
    key: "g",
    role: "assistant",
    isStreaming: false,
    messages: [{ key: "m", message }],
  }) as unknown as MessageGroup;

it("folds the scheduler prompt of an automation run as one upstream update line", () => {
  expect(readAutomationRun(cronPrompt)).toEqual({
    jobId: "job-1",
    runId: "r1",
    sourceSessionKey: "agent:main:cron:job-1:run:r1",
  });
  expect(isSessionActivityGroup(group(cronPrompt))).toBe(true);
});

it("keeps the agent's reply as an ordinary reply", () => {
  const reply = { role: "assistant", content: [{ type: "text", text: "Plan ready." }] };
  expect(isSessionActivityGroup(group(reply))).toBe(false);
});
