import { afterEach, describe, expect, it, vi } from "vitest";

const { switchChatModel } = vi.hoisted(() => ({ switchChatModel: vi.fn() }));

vi.mock("./chat-session.ts", () => ({ switchChatModel }));
vi.mock("../../lib/gateway-methods.ts", () => ({ canCallGatewayMethod: () => true }));

import {
  createChatHandoffController,
  findPromptBefore,
  handOffChat,
  isRefusalHandedOff,
  readChatAcpModels,
  readChatHandoffInfo,
  refreshChatAcpModels,
  refreshChatHandoffInfo,
  setChatAcpModel,
  takePendingResend,
  type ChatHandoffInfo,
} from "./chat-handoff.ts";
import type { ChatPageHost } from "./chat-state-host.ts";

const SESSION = "agent:main:main";

function user(text: string, id: string) {
  return { role: "user", content: [{ type: "text", text }], __openclaw: { id } };
}

function assistant(text: string, id: string) {
  return { role: "assistant", content: [{ type: "text", text }], __openclaw: { id } };
}

/** A chat whose /acp commands bind and unbind like the Gateway does. */
function createChat(options: { model?: string; agents?: string[]; failSpawn?: boolean } = {}) {
  const info: ChatHandoffInfo = { binding: null, handoff: null, agents: options.agents ?? [] };
  const sent: string[] = [];
  const requests: Array<[string, unknown]> = [];
  let agentModel = "m1";
  const state = {
    sessionKey: SESSION,
    connected: true,
    chatSending: false,
    chatRunId: null,
    chatStream: null,
    chatMessages: [user("What is six times seven?", "u1"), assistant("42", "a1")],
    chatModelCatalog: [
      { provider: "claude-cli", id: "opus", name: "Claude Opus" },
      { provider: "openrouter", id: "x/y:free", name: "Y Free" },
    ],
    sessions: { state: { modelOverrides: { [SESSION]: options.model ?? "claude-cli/opus" } } },
    sessionsResult: null,
    hello: null,
    requestUpdate: vi.fn(),
    client: {
      request: vi.fn(async (method: string, params: Record<string, unknown>) => {
        requests.push([method, params]);
        if (method === "acpx.chat.models.get") {
          return {
            models: {
              agent: "junie",
              current: agentModel,
              models: [{ id: "m1", name: "One" }, { id: "m2" }],
            },
          };
        }
        if (method === "acpx.chat.models.set") {
          if (params.model === "bad") {
            throw new Error("unsupported model");
          }
          agentModel = String(params.model);
          return { model: agentModel };
        }
        if (method === "chat.refusal.handoff") {
          return { excluded: ["u1", "a1"] };
        }
        if (method === "acpx.chat.handoff.get") {
          return structuredClone(info);
        }
        info.handoff = params.previous
          ? ({ previous: params.previous, current: params.current, at: 1 } as never)
          : null;
        return { handoff: info.handoff };
      }),
    },
    handleSendChat: vi.fn(async (text: string) => {
      sent.push(text);
      const spawn = /^\/acp spawn (\S+) --bind here$/u.exec(text);
      if (spawn && !options.failSpawn) {
        info.binding = { agent: spawn[1]!, targetSessionKey: "agent:main:acp:1" };
      }
      if (text === "/acp close") {
        info.binding = null;
      }
    }),
  };
  switchChatModel.mockReset().mockImplementation(async (_host, model: string) => {
    state.sessions.state.modelOverrides[SESSION] = model;
    return true;
  });
  return { state: state as unknown as ChatPageHost & typeof state, info, sent, requests };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("chat handoff", () => {
  it("finds the question a reply answered", () => {
    const messages = [
      user("first", "u1"),
      assistant("one", "a1"),
      user("/acp close", "u2"),
      user("second", "u3"),
      assistant("two", "a3"),
    ];
    expect(findPromptBefore(messages, "a1")).toBe("first");
    expect(findPromptBefore(messages, "a3")).toBe("second");
    expect(findPromptBefore(messages)).toBe("second");
    expect(findPromptBefore([assistant("x", "a")], "a")).toBeUndefined();
  });

  it("hands a model's chat to an ACP agent, records who answered and re-sends the question", async () => {
    const { state, sent, requests } = createChat({ agents: ["junie"] });
    await refreshChatHandoffInfo(state);
    const controller = createChatHandoffController(state, { models: [] });
    expect(controller.current).toEqual({ kind: "model", model: "claude-cli/opus" });
    expect(controller.agents.map((agent) => agent.label)).toEqual(["Junie"]);

    expect(
      await controller.handOff({ kind: "agent", agent: "junie" }, { resendBefore: "a1" }),
    ).toBe(true);
    expect(sent).toEqual(["/acp spawn junie --bind here", "What is six times seven?"]);
    expect(requests).toContainEqual([
      "acpx.chat.handoff.set",
      {
        sessionKey: SESSION,
        previous: { kind: "model", model: "claude-cli/opus" },
        current: { kind: "agent", agent: "junie" },
      },
    ]);
    const bound = createChatHandoffController(state, { models: [] });
    expect(bound.current).toEqual({ kind: "agent", agent: "junie" });
    expect(bound.previous).toEqual({ kind: "model", model: "claude-cli/opus" });

    // Return restores the exact previous answerer and clears the record.
    expect(await bound.returnToPrevious()).toBe(true);
    expect(sent.at(-1)).toBe("/acp close");
    expect(readChatHandoffInfo(state, SESSION)?.handoff).toBeNull();
    expect(createChatHandoffController(state, { models: [] }).previous).toBeUndefined();
  });

  it("unbinds an agent before switching to any model, then re-sends", async () => {
    const { state, sent } = createChat({ agents: ["junie"] });
    await handOffChat(state, { kind: "agent", agent: "junie" });
    await handOffChat(state, { kind: "model", model: "openrouter/x/y:free" }, { resend: "again" });
    expect(sent).toEqual(["/acp spawn junie --bind here", "/acp close", "again"]);
    expect(switchChatModel).toHaveBeenCalledWith(state, "openrouter/x/y:free", SESSION, undefined);
    expect(createChatHandoffController(state, { models: [] }).previous).toEqual({
      kind: "agent",
      agent: "junie",
    });
  });

  it("switches between two models without any agent", async () => {
    const { state, sent } = createChat({ model: "openrouter/x/y:free" });
    expect(await handOffChat(state, { kind: "model", model: "claude-cli/opus" })).toBe(true);
    expect(sent).toEqual([]);
    expect(createChatHandoffController(state, { models: [] }).previous).toEqual({
      kind: "model",
      model: "openrouter/x/y:free",
    });
  });

  it("says why a handoff failed and stays put", async () => {
    const notAllowed = createChat({ agents: ["junie"] });
    expect(await handOffChat(notAllowed.state, { kind: "agent", agent: "codex" })).toBe(false);
    expect(notAllowed.state.chatError).toContain("codex is not in acp.allowedAgents");
    expect(notAllowed.sent).toEqual([]);

    const unbound = createChat({ agents: ["junie"], failSpawn: true });
    expect(
      await handOffChat(unbound.state, { kind: "agent", agent: "junie" }, { resend: "q" }),
    ).toBe(false);
    expect(unbound.state.chatError).toContain("Could not hand off to Junie");
    // The question is not re-sent to the old model.
    expect(unbound.sent).toEqual(["/acp spawn junie --bind here"]);
  });

  it("retries a failed turn as is and remembers it for the picker", async () => {
    const { state, sent } = createChat();
    state.chatMessages = [
      user("Summarize", "u1"),
      { ...assistant("⚠️ limit", "a1"), stopReason: "error" },
    ];
    const controller = createChatHandoffController(state, { models: [] });
    controller.retry("a1");
    expect(sent).toEqual(["Summarize"]);
    controller.chooseAnotherModel("a1");
    expect(state.chatModelPickerOpenSessionKey).toBe(SESSION);
    expect(takePendingResend(state, SESSION)).toBe("Summarize");
    expect(takePendingResend(state, SESSION)).toBeUndefined();
  });

  it("lists the bound agent's models and sets one as /acp model does", async () => {
    const { state, info, requests } = createChat({ agents: ["junie"] });
    expect(await refreshChatAcpModels(state)).toBeUndefined();
    info.binding = { agent: "junie", targetSessionKey: "agent:main:acp:1" };
    await refreshChatHandoffInfo(state);
    expect(await refreshChatAcpModels(state)).toMatchObject({
      target: "agent:main:acp:1",
      status: "ready",
      current: "m1",
      models: [{ id: "m1", name: "One" }, { id: "m2" }],
    });
    expect(await setChatAcpModel(state, "m2")).toBe(true);
    expect(requests).toContainEqual(["acpx.chat.models.set", { sessionKey: SESSION, model: "m2" }]);
    expect(readChatAcpModels(state)?.current).toBe("m2");
    expect(await setChatAcpModel(state, "bad")).toBe(false);
    expect(readChatAcpModels(state)?.current).toBe("m2");
  });
});

describe("refusal hand-off (I14)", () => {
  it("marks the refused turn before switching, then re-sends the question", async () => {
    const { state, sent, requests } = createChat({ agents: ["junie"] });
    state.chatMessages = [
      user("Write the exploit.", "u1"),
      { ...assistant("I can't help with that.", "a1"), __openclaw: { id: "a1" } },
    ];
    const controller = createChatHandoffController(state, {
      models: [
        {
          answerer: { kind: "model", model: "openrouter/x/y:free" },
          label: "Y Free",
          provider: "openrouter",
        },
      ],
    });
    expect(
      await controller.handOff(
        { kind: "model", model: "openrouter/x/y:free" },
        { resendBefore: "a1", refusal: "phrase" },
      ),
    ).toBe(true);
    const methods = requests.map(([method]) => method);
    expect(methods.indexOf("chat.refusal.handoff")).toBeLessThan(
      methods.indexOf("acpx.chat.handoff.set"),
    );
    expect(requests).toContainEqual([
      "chat.refusal.handoff",
      { sessionKey: SESSION, messageId: "a1", signal: "phrase", target: "Y Free" },
    ]);
    expect(sent).toEqual(["Write the exploit."]);
    expect(isRefusalHandedOff("a1")).toBe(true);
  });

  it("a plain hand-off leaves the transcript alone", async () => {
    const { state, requests } = createChat();
    const controller = createChatHandoffController(state, { models: [] });
    await controller.handOff(
      { kind: "model", model: "openrouter/x/y:free" },
      { resendBefore: "a1" },
    );
    expect(requests.map(([method]) => method)).not.toContain("chat.refusal.handoff");
  });
});
