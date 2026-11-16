import { beforeEach, describe, expect, it, vi } from "vitest";

const { resolveByConversationAsync } = vi.hoisted(() => ({
  resolveByConversationAsync: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/session-binding-runtime", () => ({
  getSessionBindingService: () => ({ resolveByConversationAsync }),
}));

import { readAdvertisedAcpModels, registerChatAcpModels } from "./chat-acp-models.js";

type Handler = (ctx: {
  params: Record<string, unknown>;
  respond: (ok: boolean, payload?: unknown, error?: unknown) => void;
}) => Promise<void>;

const TARGET = "agent:junie:acp:123";

function setup(runtimeStatus?: unknown) {
  const handlers = new Map<string, Handler>();
  const manager = {
    getSessionStatus: vi.fn(async () => ({
      runtimeStatus,
      runtimeOptions: { model: "chosen-model" },
    })),
    setSessionConfigOption: vi.fn(async (params: { value: string }) => ({ model: params.value })),
  };
  const api = {
    registerGatewayMethod: (name: string, handler: Handler) => handlers.set(name, handler),
    runtime: { config: { current: () => ({ acp: {} }) } },
  };
  registerChatAcpModels(api as never, () => manager as never);
  const call = async (name: string, params: Record<string, unknown>) => {
    const respond = vi.fn();
    await handlers.get(name)!({ params, respond });
    return respond.mock.calls[0] as [boolean, unknown, unknown];
  };
  return { manager, call };
}

function bind() {
  resolveByConversationAsync.mockImplementation(async ({ conversationId }) =>
    conversationId === "agent:main:main"
      ? { targetSessionKey: TARGET, metadata: { label: "junie" } }
      : null,
  );
}

describe("ACP agent models for the chat model picker", () => {
  beforeEach(() => {
    resolveByConversationAsync.mockReset();
  });

  it("reads advertised models by id and name, without duplicates", () => {
    expect(
      readAdvertisedAcpModels({
        models: {
          currentModelId: "b",
          availableModels: [{ modelId: "a", name: "Model A" }, { modelId: "b" }, { bogus: 1 }],
          availableModelIds: ["a", "c", 5],
        },
      }),
    ).toEqual({
      current: "b",
      models: [{ id: "a", name: "Model A" }, { id: "b" }, { id: "c" }],
    });
    expect(readAdvertisedAcpModels(undefined)).toEqual({ models: [] });
    expect(readAdvertisedAcpModels({ models: "x" })).toEqual({ models: [] });
  });

  it("lists the bound agent's models from its ACP session status", async () => {
    bind();
    const { manager, call } = setup({
      models: { currentModelId: "m2", availableModels: [{ modelId: "m1" }, { modelId: "m2" }] },
    });
    const [ok, payload] = await call("acpx.chat.models.get", { sessionKey: "agent:main:main" });
    expect(ok).toBe(true);
    expect(payload).toMatchObject({
      binding: { agent: "junie", targetSessionKey: TARGET },
      models: { agent: "junie", current: "m2", models: [{ id: "m1" }, { id: "m2" }] },
    });
    expect(manager.getSessionStatus).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: TARGET }),
    );
  });

  it("falls back to the chosen runtime model and reports no list when none is advertised", async () => {
    bind();
    const { call } = setup(undefined);
    const [, payload] = await call("acpx.chat.models.get", { sessionKey: "agent:main:main" });
    expect(payload).toMatchObject({ models: { current: "chosen-model", models: [] } });
  });

  it("answers no models for an unbound chat without touching the ACP manager", async () => {
    resolveByConversationAsync.mockResolvedValue(null);
    const { manager, call } = setup();
    const [ok, payload] = await call("acpx.chat.models.get", { sessionKey: "agent:main:main" });
    expect([ok, payload]).toEqual([true, { binding: null, models: null }]);
    expect(manager.getSessionStatus).not.toHaveBeenCalled();
  });

  it("sets the model on the bound ACP session as /acp model does", async () => {
    bind();
    const { manager, call } = setup();
    const [ok, payload] = await call("acpx.chat.models.set", {
      sessionKey: "agent:main:main",
      model: "m1",
    });
    expect([ok, payload]).toEqual([true, { agent: "junie", model: "m1" }]);
    expect(manager.setSessionConfigOption).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: TARGET, key: "model", value: "m1" }),
    );
  });

  it("refuses bad parameters and an unbound chat", async () => {
    resolveByConversationAsync.mockResolvedValue(null);
    const { call } = setup();
    expect((await call("acpx.chat.models.get", {}))[0]).toBe(false);
    expect((await call("acpx.chat.models.get", { sessionKey: "x", extra: 1 }))[0]).toBe(false);
    expect((await call("acpx.chat.models.set", { sessionKey: "agent:main:main" }))[0]).toBe(false);
    expect(
      (await call("acpx.chat.models.set", { sessionKey: "agent:main:main", model: "m1" }))[0],
    ).toBe(false);
  });
});
