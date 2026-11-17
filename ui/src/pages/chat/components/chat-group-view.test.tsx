/* @vitest-environment jsdom */

import { flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import {
  publishChatGroupController,
  type ChatGroupController,
  type ChatGroupMember,
} from "../chat-group-registry.ts";
import {
  publishChatHandoffController,
  type ChatHandoffController,
} from "../chat-handoff-registry.ts";
import { ChatGroupHeaderButton, ChatGroupStrip } from "./chat-group-view.tsx";
import { ChatHandoffMessageAction } from "./chat-handoff-view.tsx";

afterEach(() => {
  document.body.replaceChildren();
});

const JUNIE: ChatGroupMember = { kind: "acp", id: "junie", name: "Junie", key: "acp:junie" };
const GEMMA: ChatGroupMember = {
  kind: "model",
  id: "or/gemma",
  name: "Gemma",
  key: "model:or/gemma",
};
let counter = 0;

function group(overrides: Partial<ChatGroupController> = {}) {
  const value: ChatGroupController = {
    sessionKey: `agent:main:group-${++counter}`,
    info: {
      members: [JUNIE, GEMMA],
      running: null,
      candidates: { agents: [{ id: "ops", name: "Ops" }], acpAgents: ["junie"] },
    },
    targets: {
      agents: [{ member: { kind: "agent", id: "ops", name: "Ops" }, label: "Ops" }],
      acpAgents: [],
      models: [{ member: { kind: "model", id: "or/opus", name: "Opus" }, label: "Opus" }],
    },
    busy: false,
    add: vi.fn(async () => true),
    remove: vi.fn(async () => true),
    ask: vi.fn(),
    stop: vi.fn(async () => {}),
    ...overrides,
  };
  publishChatGroupController(value);
  return value;
}

function mount(node: () => unknown) {
  const container = document.body.appendChild(document.createElement("div"));
  mountSolid(node as never, { container });
  flush();
  return container;
}

function openMenu(container: HTMLElement, selector: string) {
  const details = container.querySelector<HTMLDetailsElement>(selector)!;
  details.open = true;
  details.dispatchEvent(new Event("toggle"));
  flush();
}

describe("group chat buttons", () => {
  it("lists the members with Ask and remove buttons, and Stop while one answers", () => {
    const chat = group();
    const container = mount(() => <ChatGroupStrip sessionKey={chat.sessionKey} />);
    const asks = Array.from(container.querySelectorAll<HTMLButtonElement>("[data-chat-group-ask]"));
    expect(asks.map((button) => button.textContent)).toEqual(["Ask Junie", "Ask Gemma"]);
    asks[1]!.click();
    expect(chat.ask).toHaveBeenCalledWith(GEMMA);
    container.querySelector<HTMLButtonElement>('[data-chat-group-remove="acp:junie"]')!.click();
    expect(chat.remove).toHaveBeenCalledWith("acp:junie");
    expect(container.querySelector("[data-chat-group-stop]")).toBeNull();

    const busy = group({ busy: true, info: { ...chat.info!, running: "acp:junie" } });
    const running = mount(() => <ChatGroupStrip sessionKey={busy.sessionKey} />);
    expect(running.textContent).toContain("Junie is answering");
    running.querySelector<HTMLButtonElement>("[data-chat-group-stop]")!.click();
    expect(busy.stop).toHaveBeenCalled();
  });

  it("shows nothing for a chat without members", () => {
    const chat = group({
      info: { members: [], running: null, candidates: { agents: [], acpAgents: [] } },
    });
    expect(mount(() => <ChatGroupStrip sessionKey={chat.sessionKey} />).textContent).toBe("");
  });

  it("adds a participant from the chat header", () => {
    const chat = group();
    const container = mount(() => <ChatGroupHeaderButton sessionKey={chat.sessionKey} />);
    openMenu(container, "[data-chat-group-menu]");
    const items = Array.from(
      container.querySelectorAll<HTMLButtonElement>("[data-chat-group-add]"),
    );
    expect(items.map((item) => item.textContent)).toEqual(["Ops", "Opus"]);
    items[1]!.click();
    expect(chat.add).toHaveBeenCalledWith(chat.targets.models[0]);
  });

  it("the Hand off menu switches to Add to group chat and back", () => {
    const chat = group();
    const handOff = vi.fn(async () => true);
    publishChatHandoffController({
      sessionKey: chat.sessionKey,
      current: { kind: "model", model: "or/llama" },
      previous: undefined,
      info: { binding: null, handoff: null, agents: [] },
      models: [{ answerer: { kind: "model", model: "or/y" }, label: "Y" }],
      agents: [],
      longContext: false,
      busy: false,
      labelOf: () => "x",
      handOff,
      returnToPrevious: vi.fn(async () => true),
      dismiss: vi.fn(),
      retry: vi.fn(),
      chooseAnotherModel: vi.fn(),
    } satisfies ChatHandoffController);
    const container = mount(() => (
      <ChatHandoffMessageAction sessionKey={chat.sessionKey} messageKey="a1" />
    ));
    openMenu(container, "[data-chat-handoff-menu]");
    expect(container.querySelector("[data-chat-handoff-target]")).not.toBeNull();
    container.querySelector<HTMLButtonElement>('[data-chat-handoff-mode="group"]')!.click();
    flush();
    expect(container.querySelector("[data-chat-handoff-target]")).toBeNull();
    container.querySelector<HTMLButtonElement>('[data-chat-group-add="agent:ops"]')!.click();
    expect(chat.add).toHaveBeenCalledWith(chat.targets.agents[0]);
    expect(handOff).not.toHaveBeenCalled();
  });
});
