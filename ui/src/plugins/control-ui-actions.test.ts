import { describe, expect, it, vi } from "vitest";
import type { ControlUiAction, ControlUiHost } from "../../../src/plugin-sdk/control-ui.js";
import { runControlUiPluginAction } from "./control-ui-actions.ts";
import type { ControlUiPluginCapability } from "./control-ui-capability.ts";

function runtimeWith(action: ControlUiAction) {
  // The scope wraps these host services; the test needs them to exist, not to do anything.
  const host = {
    signal: new AbortController().signal,
    sessions: {},
    agents: {},
    navigation: {},
    ui: {},
    components: {},
  } as unknown as ControlUiHost;
  const entry = { key: "demo/ask" as const, pluginId: "demo", value: action, host, signal: new AbortController().signal };
  return {
    registrations: (kind: string) => (kind === "actions" ? [entry] : []),
    reportError: vi.fn(),
  } as unknown as ControlUiPluginCapability;
}

describe("plugin message actions (fork)", () => {
  it("runs with the chat's session and a copy of the message", async () => {
    const run = vi.fn();
    const resolve = vi.fn((_context: unknown) => ({}));
    const message = { role: "assistant", text: "**Pears** ripen in August.", id: "entry-7" };
    await runControlUiPluginAction({
      runtime: runtimeWith({ id: "ask", label: "Ask", placement: "message", resolve, run }),
      id: "demo/ask",
      placement: "message",
      sessionKey: "agent:garden:main",
      agentId: "garden",
      message,
      signal: new AbortController().signal,
    });
    expect(resolve).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: "agent:garden:main", agentId: "garden", message }),
    );
    const context = (run.mock.calls as unknown as Array<[{ message: unknown }]>)[0]?.[0];
    expect(context).toMatchObject({ sessionKey: "agent:garden:main", agentId: "garden", message });
    expect(context?.message).not.toBe(message);
  });

  it("refuses a message action without a message, and a placement the action does not have", async () => {
    const runtime = runtimeWith({ id: "ask", label: "Ask", placement: "message", run: vi.fn() });
    const base = { runtime, id: "demo/ask", sessionKey: "agent:garden:main", signal: new AbortController().signal };
    await expect(runControlUiPluginAction({ ...base, placement: "message" })).rejects.toThrow(/message is no longer available/);
    await expect(
      runControlUiPluginAction({ ...base, placement: "composer", message: { role: "user", text: "x" } }),
    ).rejects.toThrow(/no longer active/);
  });
});
