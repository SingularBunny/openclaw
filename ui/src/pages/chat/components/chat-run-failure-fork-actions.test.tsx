/* @vitest-environment jsdom */

import { flush } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import {
  formatAgentLabel,
  publishChatHandoffController,
  type ChatAnswerer,
  type ChatHandoffController,
} from "../chat-handoff-registry.ts";
import { ChatNotice } from "./chat-notice-view.tsx";

afterEach(() => {
  document.body.replaceChildren();
});

function controller(sessionKey: string): ChatHandoffController {
  const value: ChatHandoffController = {
    sessionKey,
    current: { kind: "model", model: "demo/alpha" },
    previous: undefined,
    info: { binding: null, handoff: null, agents: [] },
    models: [{ answerer: { kind: "model", model: "demo/beta" }, label: "Beta" }],
    agents: [],
    longContext: false,
    busy: false,
    labelOf: (answerer: ChatAnswerer) =>
      answerer.kind === "agent" ? formatAgentLabel(answerer.agent) : answerer.model,
    handOff: vi.fn(async () => true),
    returnToPrevious: vi.fn(async () => true),
    dismiss: vi.fn(),
    retry: vi.fn(),
    chooseAnotherModel: vi.fn(),
  };
  publishChatHandoffController(value);
  return value;
}

const item = {
  kind: "notice" as const,
  key: "failure",
  label: "",
  text: "",
  timestamp: 1,
  runError: { runId: "run-a", summary: "Provider returned 500" },
};

function draw(recovery: Parameters<typeof ChatNotice>[0]["recovery"]) {
  const container = document.body.appendChild(document.createElement("div"));
  mountSolid(() => <ChatNotice item={item} recovery={recovery} />, { container });
  flush();
  return container;
}

it("adds Retry and Choose another model beside upstream's Try again on the latest failure", () => {
  const chat = controller("agent:main:failure-1");
  const onRetryRun = vi.fn();
  const container = draw({ sessionKey: chat.sessionKey, failureActionsRunId: "run-a", onRetryRun });
  expect(container.querySelector(".chat-run-failure__retry")).not.toBeNull();
  container.querySelector<HTMLButtonElement>("[data-chat-turn-retry]")!.click();
  expect(chat.retry).toHaveBeenCalledOnce();
  expect(onRetryRun).not.toHaveBeenCalled();
  container.querySelector<HTMLButtonElement>("[data-chat-turn-choose-model]")!.click();
  expect(chat.chooseAnotherModel).toHaveBeenCalledOnce();
});

it("shows no fork buttons on an older failure or while a run is active", () => {
  const chat = controller("agent:main:failure-2");
  const older = draw({ sessionKey: chat.sessionKey, failureActionsRunId: "run-b" });
  expect(older.querySelector("[data-chat-turn-failure-actions]")).toBeNull();
  const active = draw({
    sessionKey: chat.sessionKey,
    failureActionsRunId: "run-a",
    runActive: true,
  });
  expect(active.querySelector("[data-chat-turn-failure-actions]")).toBeNull();
});
