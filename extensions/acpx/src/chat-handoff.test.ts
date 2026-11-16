import { beforeEach, describe, expect, it, vi } from "vitest";

const { resolveByConversationAsync } = vi.hoisted(() => ({
  resolveByConversationAsync: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/session-binding-runtime", () => ({
  getSessionBindingService: () => ({ resolveByConversationAsync }),
}));

import {
  buildChatHandoffNote,
  listHandoffAcpAgents,
  parseChatAnswerer,
  registerChatHandoff,
  type ChatHandoffRecord,
} from "./chat-handoff.js";

type Handler = (ctx: {
  params: Record<string, unknown>;
  respond: (ok: boolean, payload?: unknown, error?: unknown) => void;
}) => Promise<void>;

function setup() {
  const handlers = new Map<string, Handler>();
  const enqueueNextTurnInjection = vi.fn(async () => ({ enqueued: true, id: "x", sessionKey: "" }));
  const rows = new Map<string, ChatHandoffRecord>();
  const api = {
    registerGatewayMethod: (name: string, handler: Handler) => handlers.set(name, handler),
    session: { workflow: { enqueueNextTurnInjection } },
    runtime: { config: { current: () => ({ acp: { allowedAgents: ["junie", "codex"] } }) } },
  };
  registerChatHandoff(api as never, () => ({
    lookup: async (key) => rows.get(key),
    register: async (key, value) => void rows.set(key, value),
    delete: async (key) => rows.delete(key),
  }));
  const call = async (name: string, params: Record<string, unknown>) => {
    const respond = vi.fn();
    await handlers.get(name)!({ params, respond });
    return respond.mock.calls[0] as [boolean, unknown, unknown];
  };
  return { call, enqueueNextTurnInjection, rows };
}

describe("chat handoff gateway methods", () => {
  beforeEach(() => {
    resolveByConversationAsync.mockReset().mockResolvedValue(null);
  });

  it("reports the ACP agent a Control UI chat is bound to", async () => {
    const { call } = setup();
    resolveByConversationAsync.mockImplementation(async (ref: { conversationId: string }) =>
      ref.conversationId === "agent:main:main"
        ? {
            targetSessionKey: "agent:main:acp:1234",
            boundAt: 5,
            metadata: { agentId: "main", label: "junie" },
          }
        : null,
    );
    expect(await call("acpx.chat.handoff.get", { sessionKey: "main" })).toEqual([
      true,
      {
        binding: { agent: "junie", targetSessionKey: "agent:main:acp:1234", boundAt: 5 },
        handoff: null,
        agents: ["junie", "codex"],
      },
      undefined,
    ]);
    expect(resolveByConversationAsync).toHaveBeenCalledWith({
      channel: "webchat",
      accountId: "default",
      conversationId: "main",
    });
  });

  it("ignores bindings to non-ACP sessions and rejects unknown params", async () => {
    const { call } = setup();
    resolveByConversationAsync.mockResolvedValue({ targetSessionKey: "agent:main:other" });
    expect((await call("acpx.chat.handoff.get", { sessionKey: "agent:main:x" }))[1]).toEqual({
      binding: null,
      handoff: null,
      agents: ["junie", "codex"],
    });
    expect((await call("acpx.chat.handoff.get", { sessionKey: "x", extra: 1 }))[0]).toBe(false);
  });

  it("records a handoff between any two answerers, queues the switch note and clears it", async () => {
    const { call, enqueueNextTurnInjection, rows } = setup();
    const previous = { kind: "model", model: "openrouter/x/y" };
    const current = { kind: "agent", agent: "junie" };
    const [ok, payload] = await call("acpx.chat.handoff.set", {
      sessionKey: "agent:main:main",
      previous,
      current,
    });
    expect(ok).toBe(true);
    expect(payload).toMatchObject({ handoff: { previous, current } });
    expect(rows.get("agent:main:main")).toMatchObject({ previous, current });
    expect(enqueueNextTurnInjection).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:main",
        text: expect.stringContaining(
          "changed from the model openrouter/x/y to the ACP agent junie",
        ),
      }),
    );
    expect(
      (await call("acpx.chat.handoff.get", { sessionKey: "agent:main:main" }))[1],
    ).toMatchObject({ handoff: { previous, current } });
    expect(
      await call("acpx.chat.handoff.set", {
        sessionKey: "agent:main:main",
        previous: null,
        current: null,
      }),
    ).toEqual([true, { handoff: null }, undefined]);
    expect(rows.size).toBe(0);
    expect(
      (await call("acpx.chat.handoff.set", { sessionKey: "agent:main:main", previous })).at(0),
    ).toBe(false);
  });
});

describe("chat answerers", () => {
  it("accepts a model ref or an ACP agent id and nothing else", () => {
    expect(parseChatAnswerer({ kind: "model", model: "groq/llama", agentRuntime: "pi" })).toEqual({
      kind: "model",
      model: "groq/llama",
      agentRuntime: "pi",
    });
    expect(parseChatAnswerer({ kind: "agent", agent: "junie" })).toEqual({
      kind: "agent",
      agent: "junie",
    });
    expect(parseChatAnswerer({ kind: "agent" })).toBeUndefined();
    expect(parseChatAnswerer("junie")).toBeUndefined();
    expect(listHandoffAcpAgents({ allowedAgents: ["junie", "junie", " "] })).toEqual(["junie"]);
    expect(listHandoffAcpAgents({ defaultAgent: "codex" })).toEqual(["codex"]);
    expect(listHandoffAcpAgents({ enabled: false, allowedAgents: ["junie"] })).toEqual([]);
    expect(
      buildChatHandoffNote({
        previous: { kind: "agent", agent: "junie" },
        current: { kind: "model", model: "claude-cli/opus" },
        at: 1,
      }),
    ).toContain("do not claim another model's or agent's replies as your own");
  });
});
