import { beforeEach, describe, expect, it, vi } from "vitest";

const { resolveByConversationAsync } = vi.hoisted(() => ({
  resolveByConversationAsync: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/session-binding-runtime", () => ({
  getSessionBindingService: () => ({ resolveByConversationAsync }),
}));

import { acpxChatPermissionsAvailable, registerChatPermissions } from "./chat-permissions.js";
import { AcpxSessionPermissionModes } from "./permission-modes.js";

type Handler = (ctx: {
  params: Record<string, unknown>;
  respond: (ok: boolean, payload?: unknown, error?: unknown) => void;
}) => Promise<void>;

const TARGET = "agent:junie:acp:123";

function setup(acpxConfig: Record<string, unknown> = {}) {
  const handlers = new Map<string, { handler: Handler; scope?: string }>();
  const modes = new AcpxSessionPermissionModes();
  const api = {
    registerGatewayMethod: (name: string, handler: Handler, opts?: { scope?: string }) =>
      handlers.set(name, { handler, scope: opts?.scope }),
    runtime: {
      config: { current: () => ({ plugins: { entries: { acpx: { config: acpxConfig } } } }) },
    },
  };
  registerChatPermissions(api as never, modes);
  const call = async (name: string, params: Record<string, unknown>) => {
    const respond = vi.fn();
    await handlers.get(name)!.handler({ params, respond });
    return respond.mock.calls[0] as [boolean, unknown, unknown];
  };
  return { modes, call, handlers };
}

function bind() {
  resolveByConversationAsync.mockImplementation(async ({ conversationId }) =>
    conversationId === "agent:main:main"
      ? { targetSessionKey: TARGET, metadata: { label: "junie" } }
      : null,
  );
}

describe("ACP permission mode of a bound chat", () => {
  beforeEach(() => {
    resolveByConversationAsync.mockReset();
  });

  it("is offered only where permission questions reach the chat", () => {
    expect(acpxChatPermissionsAvailable({})).toBe(true);
    expect(acpxChatPermissionsAvailable({ permissionMode: "approve-all" })).toBe(false);
    expect(acpxChatPermissionsAvailable({ permissionMode: "deny-all" })).toBe(false);
    expect(acpxChatPermissionsAvailable({ nonInteractivePermissions: "deny" })).toBe(false);
  });

  it("reads and switches the bound ACP session's mode, never another session's", async () => {
    bind();
    const { modes, call } = setup();
    expect(await call("acpx.chat.permissions.get", { sessionKey: "agent:main:main" })).toEqual([
      true,
      { targetSessionKey: TARGET, available: true, mode: "ask" },
      undefined,
    ]);
    expect(
      (
        await call("acpx.chat.permissions.set", {
          sessionKey: "agent:main:main",
          mode: "allow-all",
        })
      )[0],
    ).toBe(true);
    expect(await modes.get(TARGET)).toBe("allow-all");
    expect(await modes.get("agent:junie:acp:other")).toBe("ask");
    expect((await call("acpx.chat.permissions.get", { sessionKey: "agent:main:main" }))[1]).toEqual(
      expect.objectContaining({ mode: "allow-all" }),
    );
    await call("acpx.chat.permissions.set", { sessionKey: "agent:main:main", mode: "ask" });
    expect(await modes.get(TARGET)).toBe("ask");
  });

  it("refuses a chat with no bound agent, bad input and allow all where nothing asks", async () => {
    bind();
    const { call } = setup({ permissionMode: "deny-all" });
    expect(
      (await call("acpx.chat.permissions.get", { sessionKey: "agent:main:other" }))[1],
    ).toEqual({ targetSessionKey: null, available: false, mode: "ask" });
    expect(
      (await call("acpx.chat.permissions.set", { sessionKey: "agent:main:other", mode: "ask" }))[0],
    ).toBe(false);
    expect(
      (await call("acpx.chat.permissions.set", { sessionKey: "agent:main:main", mode: "yes" }))[0],
    ).toBe(false);
    expect(
      (
        await call("acpx.chat.permissions.set", {
          sessionKey: "agent:main:main",
          mode: "allow-all",
        })
      )[0],
    ).toBe(false);
  });

  it("needs write to switch and read to look", () => {
    const { handlers } = setup();
    expect(handlers.get("acpx.chat.permissions.get")?.scope).toBe("operator.read");
    expect(handlers.get("acpx.chat.permissions.set")?.scope).toBe("operator.write");
  });
});
