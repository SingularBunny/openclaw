import { describe, expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { ChatPaneNativeSessionActions } from "./chat-pane-native-session-actions.ts";

function contextWith(nativeConversation?: { supportsSessionActions: boolean }) {
  const entry = {
    key: "aiwb-chat-tools/forget-topic",
    pluginId: "aiwb-chat-tools",
    value: { id: "forget-topic", label: "Forget a topic…", placement: "session", run: vi.fn() },
  };
  return {
    plugins: {
      registrations: (kind: string) => (kind === "actions" ? [entry] : []),
      reportError: vi.fn(),
    },
    gateway: { snapshot: undefined },
    ...(nativeConversation ? { nativeConversation } : {}),
  } as unknown as ApplicationContext;
}

const row = { key: "agent:main:main", agentId: "main" } as unknown as GatewaySessionRow;

describe("chat ⋯ menu plugin session actions (fork)", () => {
  it("lists plugin session actions in the browser, as the sidebar menu does", () => {
    const actions = new ChatPaneNativeSessionActions().read(contextWith(), row, undefined, vi.fn());
    expect(actions.map((action) => [action.id, action.label])).toEqual([
      ["plugin/aiwb-chat-tools/forget-topic", "Forget a topic…"],
    ]);
  });

  it("leaves them to a native host that has not opted in", () => {
    const actions = new ChatPaneNativeSessionActions().read(
      contextWith({ supportsSessionActions: false }),
      row,
      undefined,
      vi.fn(),
    );
    expect(actions).toEqual([]);
  });
});
