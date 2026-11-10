// Fork (F52): a rewind removes the cut turns' answered questions and "Done in …" recap.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createQuestionPromptState,
  disposeQuestionPromptState,
  handleQuestionPromptEvent,
  listQuestionPrompts,
} from "../../app/question-prompt.ts";
import { captureRewoundTurnLeftovers, readChatRewindCutTime } from "./chat-rewind-leftovers.ts";

const SESSION = "agent:main:dashboard:rewind";
const states: ReturnType<typeof createQuestionPromptState>[] = [];
afterEach(() => {
  for (const state of states.splice(0)) {
    disposeQuestionPromptState(state);
  }
});

function question(id: string, createdAtMs: number, sessionKey = SESSION) {
  return {
    id,
    questions: [
      {
        questionId: "plan_approval",
        header: "Plan",
        question: "Claude has finished planning. Would you like to proceed?",
        options: [{ label: "Yes, and manually approve edits" }, { label: "No, keep planning" }],
        isOther: true,
      },
    ],
    agentId: "main",
    sessionKey,
    runId: `run-${id}`,
    createdAtMs,
    expiresAtMs: Date.now() + 60_000,
    status: "pending",
  };
}

function questionState(...records: ReturnType<typeof question>[]) {
  const state = createQuestionPromptState(vi.fn());
  states.push(state);
  for (const record of records) {
    handleQuestionPromptEvent(state, { event: "question.requested", payload: record });
  }
  return state;
}

function answer(state: ReturnType<typeof questionState>, id: string) {
  handleQuestionPromptEvent(state, {
    event: "question.resolved",
    payload: {
      id,
      status: "answered",
      answers: { answers: { plan_approval: ["Yes, and manually approve edits"] } },
    },
  });
}

function chat(messages: unknown[]) {
  return { sessionKey: SESSION, chatMessages: messages, hello: null, agentsList: null };
}

const firstPrompt = {
  role: "user",
  content: "count lines",
  timestamp: 1_000,
  __openclaw: { id: "m1" },
};
const secondPrompt = {
  role: "user",
  content: "append a line",
  timestamp: 5_000,
  __openclaw: { id: "m2" },
};

describe("rewind leftovers", () => {
  it("reads the cut message time", () => {
    expect(readChatRewindCutTime([firstPrompt, secondPrompt], "m2")).toBe(5_000);
    expect(readChatRewindCutTime([firstPrompt], "missing")).toBeNull();
  });

  it("drops the cut turns' answered questions and the turn recap", () => {
    const state = questionState(
      question("earlier", 2_000),
      question("cut", 6_000),
      question("other-chat", 6_000, "agent:main:dashboard:other"),
      question("still-pending", 7_000),
    );
    answer(state, "earlier");
    answer(state, "cut");
    answer(state, "other-chat");
    const transcript = {
      turnRecapWatch: {
        sessionKey: SESSION,
        agentId: null,
        gatewayClient: null,
        runId: "run-cut",
        request: null,
        recap: { runtimeMs: 74_000, outputTokens: null },
      },
    };

    captureRewoundTurnLeftovers(chat([firstPrompt, secondPrompt]), "m2").clear(state, transcript);

    expect(listQuestionPrompts(state).map((prompt) => prompt.id)).toEqual([
      "earlier",
      "other-chat",
      "still-pending",
    ]);
    expect(transcript.turnRecapWatch).toBeNull();
  });

  it("drops every answered question of the chat when the cut time is unknown", () => {
    const state = questionState(question("earlier", 2_000), question("cut", 6_000));
    answer(state, "earlier");
    answer(state, "cut");

    captureRewoundTurnLeftovers(chat([]), "m2").clear(state, { turnRecapWatch: null });

    expect(listQuestionPrompts(state)).toEqual([]);
  });
});
