import { describe, expect, it, vi } from "vitest";

const { access } = vi.hoisted(() => ({
  access: { allowed: true } as { allowed: boolean; reason?: string },
}));

vi.mock("../../lib/session-method-access.ts", () => ({
  readSessionMethodAccess: () => access,
}));

import {
  ChatCommandMenuActions,
  chatCommandDisabledReason,
  runChatMenuCommand,
} from "./chat-command-menu-actions.ts";

function createHost(connected = true) {
  return {
    client: {},
    hello: null,
    connected,
    sessionKey: "agent:main:main",
    handleSendChat: vi.fn(async () => true),
    createChatSession: vi.fn(async () => true),
  } as never as Parameters<typeof runChatMenuCommand>[0] & {
    handleSendChat: ReturnType<typeof vi.fn>;
    createChatSession: ReturnType<typeof vi.fn>;
  };
}

describe("chat menu commands", () => {
  it("lists New chat, Learn and Reset as menu items", () => {
    const plugin = { id: "plugin/x", label: "X", icon: undefined as never, onActivate: vi.fn() };
    const actions = new ChatCommandMenuActions().read(createHost(), [plugin], { confirm: vi.fn() });
    expect(actions.map((action) => action.id)).toEqual([
      "command-new",
      "command-learn",
      "command-reset",
      "plugin/x",
    ]);
    expect(actions.every((action) => !action.disabled)).toBe(true);
  });

  it("New chat opens a new chat as /new does", async () => {
    const host = createHost();
    expect(await runChatMenuCommand(host, "new", { confirm: vi.fn() })).toBe(true);
    expect(host.createChatSession).toHaveBeenCalledOnce();
    expect(host.handleSendChat).not.toHaveBeenCalled();
  });

  it("Reset asks first and sends /reset only when confirmed", async () => {
    const host = createHost();
    const confirm = vi.fn(async () => false);
    expect(await runChatMenuCommand(host, "reset", { confirm })).toBe(false);
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ danger: true }));
    expect(host.handleSendChat).not.toHaveBeenCalled();
    confirm.mockResolvedValue(true);
    expect(await runChatMenuCommand(host, "reset", { confirm })).toBe(true);
    expect(host.handleSendChat).toHaveBeenCalledWith("/reset");
  });

  it("Learn sends /learn", async () => {
    const host = createHost();
    await runChatMenuCommand(host, "learn", { confirm: vi.fn() });
    expect(host.handleSendChat).toHaveBeenCalledWith("/learn");
  });

  it("disables the items offline or without access and runs nothing", async () => {
    const offline = createHost(false);
    expect(chatCommandDisabledReason(offline, "learn")).toBeTruthy();
    const items = new ChatCommandMenuActions().read(offline, [], { confirm: vi.fn() });
    expect(items.every((item) => item.disabled)).toBe(true);
    access.allowed = false;
    access.reason = "needs admin";
    const host = createHost();
    expect(chatCommandDisabledReason(host, "reset")).toBe("needs admin");
    expect(await runChatMenuCommand(host, "reset", { confirm: vi.fn(async () => true) })).toBe(
      false,
    );
    expect(host.handleSendChat).not.toHaveBeenCalled();
    access.allowed = true;
  });
});
