// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/gateway-methods.ts", () => ({ canCallGatewayMethod: () => true }));

import {
  draftAskingMember,
  parseChatGroupMentions,
  type ChatGroupMember,
} from "./chat-group-registry.ts";
import {
  createChatGroupController,
  readChatGroupInfo,
  refreshChatGroup,
  routeChatGroupSend,
} from "./chat-group.ts";
import type { ChatPageHost } from "./chat-state-host.ts";

const JUNIE: ChatGroupMember = { kind: "acp", id: "junie", name: "Junie", key: "acp:junie" };
const GEMMA: ChatGroupMember = {
  kind: "model",
  id: "openrouter/google/gemma:free",
  name: "Gemma",
  key: "model:openrouter/google/gemma:free",
};
const GARDEN: ChatGroupMember = {
  kind: "agent",
  id: "garden",
  name: "Orchard keeper",
  key: "agent:garden",
};
const MEMBERS = [JUNIE, GEMMA, GARDEN];

function host() {
  const requests: Array<[string, Record<string, unknown>]> = [];
  let members: ChatGroupMember[] = [...MEMBERS];
  const state = {
    sessionKey: "agent:main:main",
    connected: true,
    hello: null,
    chatMessage: "",
    chatMentions: undefined,
    chatAttachments: [] as unknown[],
    chatSending: false,
    chatRunId: null as string | null,
    chatStream: null as string | null,
    requestUpdate: vi.fn(),
    client: {
      request: vi.fn(async (method: string, params: Record<string, unknown>) => {
        requests.push([method, params]);
        if (method === "aiwb-groups.chat.add") {
          const member = params.member as Omit<ChatGroupMember, "key">;
          members = [...members, { ...member, key: `${member.kind}:${member.id}` }];
        }
        return {
          members,
          running: null,
          candidates: {
            agents: [
              { id: "garden", name: "Orchard keeper" },
              { id: "ops", name: "Ops" },
            ],
            acpAgents: ["junie", "codex"],
          },
        };
      }),
    },
  };
  return { state: state as unknown as ChatPageHost & typeof state, requests };
}

describe("group chat: who answers next", () => {
  it("finds members by @name, first word, id or a model's short id, in order and once", () => {
    expect(parseChatGroupMentions("@orchard and @Junie, what now? @junie", MEMBERS)).toEqual([
      GARDEN,
      JUNIE,
    ]);
    expect(parseChatGroupMentions("@gemma:free hi", MEMBERS)).toEqual([GEMMA]);
    expect(parseChatGroupMentions("@Orchard keeper: pears?", MEMBERS)).toEqual([GARDEN]);
    expect(parseChatGroupMentions("mail a@junie.dev, @nobody", MEMBERS)).toEqual([]);
  });

  it('"Ask <name>" puts the mention in front of the draft, replacing a leading one', () => {
    expect(draftAskingMember("", JUNIE, MEMBERS)).toBe("@Junie ");
    expect(draftAskingMember("check the tests", JUNIE, MEMBERS)).toBe("@Junie check the tests");
    expect(draftAskingMember("@Gemma check the tests", JUNIE, MEMBERS)).toBe(
      "@Junie check the tests",
    );
    expect(draftAskingMember("@Orchard keeper why?", GEMMA, MEMBERS)).toBe("@Gemma why?");
  });
});

describe("group chat: sending", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("sends a message naming members to them, one by one, writing the question once", async () => {
    const { state, requests } = host();
    await refreshChatGroup(state);
    state.chatMessage = "@Gemma and @Junie: review the plan";
    const sent = routeChatGroupSend(state, undefined, undefined);
    expect(sent).toBeInstanceOf(Promise);
    expect(state.chatMessage).toBe("");
    vi.useFakeTimers();
    const done = sent!.then(() => "done");
    await vi.runAllTimersAsync();
    expect(await done).toBe("done");
    const asks = requests.filter(([method]) => method === "aiwb-groups.chat.ask");
    expect(asks.map(([, params]) => [params.member, params.record])).toEqual([
      [GEMMA.key, true],
      [JUNIE.key, false],
    ]);
    expect(asks[0]![1]).toMatchObject({
      sessionKey: "agent:main:main",
      text: "@Gemma and @Junie: review the plan",
    });
  });

  it("leaves commands, attachments, goals and messages naming nobody to the chat's own answerer", async () => {
    const { state } = host();
    expect(routeChatGroupSend(state, "@Junie hi", undefined)).toBeUndefined(); // members not loaded
    await refreshChatGroup(state);
    expect(routeChatGroupSend(state, "hello there", undefined)).toBeUndefined();
    expect(routeChatGroupSend(state, "/status @Junie", undefined)).toBeUndefined();
    expect(routeChatGroupSend(state, "@Junie hi", { intent: "goal" })).toBeUndefined();
    state.chatMessage = "@Junie look";
    state.chatAttachments = [
      { id: "a", mimeType: "text/plain" } as (typeof state.chatAttachments)[number],
    ];
    expect(routeChatGroupSend(state, undefined, undefined)).toBeUndefined();
    // While the chat's own turn runs, a message to a member waits and keeps the draft.
    state.chatAttachments = [];
    state.chatRunId = "run-1";
    await routeChatGroupSend(state, undefined, undefined);
    expect(state.chatMessage).toBe("@Junie look");
  });

  it("offers agents, ACP agents and models not yet in the chat, and adds the picked one", async () => {
    const { state, requests } = host();
    await refreshChatGroup(state);
    const controller = createChatGroupController(state, {
      models: [
        { answerer: { kind: "model", model: GEMMA.id }, label: "Gemma" },
        { answerer: { kind: "model", model: "anthropic/opus" }, label: "Opus" },
        { answerer: { kind: "agent", agent: "junie" }, label: "Junie" },
      ],
    });
    expect(controller.targets.agents.map((target) => target.member.id)).toEqual(["ops"]);
    expect(controller.targets.acpAgents.map((target) => target.member.id)).toEqual(["codex"]);
    expect(controller.targets.models.map((target) => target.member.id)).toEqual(["anthropic/opus"]);
    expect(await controller.add(controller.targets.models[0]!)).toBe(true);
    expect(requests.at(-1)).toEqual([
      "aiwb-groups.chat.add",
      {
        sessionKey: "agent:main:main",
        member: { kind: "model", id: "anthropic/opus", name: "Opus" },
      },
    ]);
    expect(readChatGroupInfo(state)?.members.map((member) => member.key)).toContain(
      "model:anthropic/opus",
    );
    state.chatMessage = "@Gemma what next?";
    controller.ask(JUNIE);
    expect(state.chatMessage).toBe("@Junie what next?");
  });
});
