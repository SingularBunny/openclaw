/* @vitest-environment jsdom */

import { flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import {
  formatAgentLabel,
  publishChatHandoffController,
  type ChatAnswerer,
  type ChatHandoffController,
} from "../chat-handoff-registry.ts";
import {
  ChatHandoffChip,
  ChatHandoffMessageAction,
  ChatRefusalHint,
  ChatTurnFailureActions,
} from "./chat-handoff-view.tsx";

afterEach(() => {
  document.body.replaceChildren();
});

let sessionCounter = 0;

function controller(overrides: Partial<ChatHandoffController> = {}) {
  const sessionKey = `agent:main:handoff-${++sessionCounter}`;
  const label = (answerer: ChatAnswerer) =>
    answerer.kind === "agent" ? formatAgentLabel(answerer.agent) : answerer.model.split("/").pop()!;
  const value: ChatHandoffController = {
    sessionKey,
    current: { kind: "model", model: "groq/llama" },
    previous: undefined,
    info: { binding: null, handoff: null, agents: ["junie"] },
    models: [
      { answerer: { kind: "model", model: "groq/llama" }, label: "Llama" },
      { answerer: { kind: "model", model: "openrouter/x/y" }, label: "Y" },
    ],
    agents: [{ answerer: { kind: "agent", agent: "junie" }, label: "Junie" }],
    longContext: false,
    busy: false,
    labelOf: label,
    handOff: vi.fn(async () => true),
    returnToPrevious: vi.fn(async () => true),
    dismiss: vi.fn(),
    retry: vi.fn(),
    chooseAnotherModel: vi.fn(),
    ...overrides,
  };
  publishChatHandoffController(value);
  return value;
}

function mount(node: () => unknown) {
  const container = document.body.appendChild(document.createElement("div"));
  mountSolid(node as never, { container });
  flush();
  return container;
}

describe("handoff buttons", () => {
  it("offers every model and agent under a reply and re-asks the reply's question", () => {
    const chat = controller({ longContext: true });
    const container = mount(() => (
      <ChatHandoffMessageAction sessionKey={chat.sessionKey} messageKey="a1" />
    ));
    const details = container.querySelector<HTMLDetailsElement>("[data-chat-handoff-menu]")!;
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
    flush();
    expect(container.querySelector("[data-chat-handoff-long-context]")).not.toBeNull();
    const items = Array.from(container.querySelectorAll<HTMLButtonElement>("[role=menuitem]"));
    expect(items.map((item) => item.textContent)).toEqual(["Junie", "Llama", "Y"]);
    // The current answerer cannot be picked again.
    expect(items[1]!.disabled).toBe(true);
    items[2]!.click();
    expect(chat.handOff).toHaveBeenCalledWith(
      { kind: "model", model: "openrouter/x/y" },
      { resendBefore: "a1" },
    );
    items[0]!.click();
    expect(chat.handOff).toHaveBeenLastCalledWith(
      { kind: "agent", agent: "junie" },
      { resendBefore: "a1" },
    );
  });

  it("shows who answers after a handoff and returns to whoever answered before", () => {
    const chat = controller({
      current: { kind: "agent", agent: "junie" },
      previous: { kind: "model", model: "openrouter/x/y" },
      info: {
        binding: { agent: "junie", targetSessionKey: "agent:main:acp:1" },
        handoff: {
          previous: { kind: "model", model: "openrouter/x/y" },
          current: { kind: "agent", agent: "junie" },
          at: 1,
        },
        agents: ["junie"],
      },
    });
    const container = mount(() => <ChatHandoffChip sessionKey={chat.sessionKey} />);
    const chip = container.querySelector("[data-chat-handoff-chip]");
    expect(chip?.textContent).toContain("Junie is answering");
    const back = container.querySelector<HTMLButtonElement>("[data-chat-handoff-return]")!;
    expect(back.textContent).toBe("Return to y");
    back.click();
    expect(chat.returnToPrevious).toHaveBeenCalled();
    container.querySelector<HTMLButtonElement>("[data-chat-handoff-dismiss]")!.click();
    expect(chat.dismiss).toHaveBeenCalled();

    const plain = controller();
    const empty = mount(() => <ChatHandoffChip sessionKey={plain.sessionKey} />);
    expect(empty.querySelector("[data-chat-handoff-chip]")).toBeNull();
  });

  it("puts Retry first and Choose another model second under a failed turn", () => {
    const chat = controller();
    const container = mount(() => (
      <ChatTurnFailureActions sessionKey={chat.sessionKey} messageKey="a9" />
    ));
    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>("button"));
    expect(buttons.map((button) => button.textContent)).toEqual(["Retry", "Choose another model"]);
    buttons[0]!.click();
    expect(chat.retry).toHaveBeenCalledWith("a9");
    buttons[1]!.click();
    expect(chat.chooseAnotherModel).toHaveBeenCalledWith("a9");
  });
});

describe("refusal hint (I14)", () => {
  function openMenu(container: HTMLElement) {
    const details = container.querySelector<HTMLDetailsElement>("[data-chat-handoff-menu]")!;
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
    flush();
    return Array.from(container.querySelectorAll<HTMLButtonElement>("[role=menuitem]"));
  }

  it("asks before handing a declined reply off and passes the signal to the hand-off", () => {
    const chat = controller();
    const container = mount(() => (
      <ChatRefusalHint sessionKey={chat.sessionKey} messageKey="a-refused-1" refusal="provider" />
    ));
    const hint = container.querySelector("[data-chat-refusal-hint]")!;
    expect(hint.textContent).toContain(
      "Looks like the model declined — hand off to another model?",
    );
    expect(hint.textContent).toContain("Hand off…");
    // Nothing is switched until the user picks a target.
    expect(chat.handOff).not.toHaveBeenCalled();
    const items = openMenu(container);
    expect(items.map((item) => item.textContent)).toEqual(["Junie", "Llama", "Y"]);
    items[2]!.click();
    expect(chat.handOff).toHaveBeenCalledWith(
      { kind: "model", model: "openrouter/x/y" },
      { resendBefore: "a-refused-1", refusal: "provider" },
    );
  });

  it("words a phrase match softer", () => {
    const chat = controller();
    const container = mount(() => (
      <ChatRefusalHint sessionKey={chat.sessionKey} messageKey="a-refused-2" refusal="phrase" />
    ));
    const hint = container.querySelector("[data-chat-refusal-hint=phrase]")!;
    expect(hint.textContent).toContain("This may be a refusal — hand off to another model?");
    expect(hint.classList.contains("chat-refusal-hint--weak")).toBe(true);
  });

  it("the plain hand-off button under a reply carries no refusal", () => {
    const chat = controller();
    const container = mount(() => (
      <ChatHandoffMessageAction sessionKey={chat.sessionKey} messageKey="a-plain" />
    ));
    openMenu(container)[0]!.click();
    expect(chat.handOff).toHaveBeenCalledWith(
      { kind: "agent", agent: "junie" },
      { resendBefore: "a-plain" },
    );
  });
});
