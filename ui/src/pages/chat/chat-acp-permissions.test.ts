import { describe, expect, it, vi } from "vitest";

vi.mock("../../lib/gateway-methods.ts", () => ({ canCallGatewayMethod: () => true }));

import { buildChatAcpPermissionToggle, refreshChatAcpPermissions } from "./chat-acp-permissions.ts";
import { refreshChatHandoffInfo } from "./chat-handoff.ts";
import type { ChatPageHost } from "./chat-state-host.ts";

const SESSION = "agent:main:main";
const TARGET = "agent:junie:acp:1";

function createChat(options: { bound?: boolean; available?: boolean } = {}) {
  let mode = "ask";
  const requests: Array<[string, unknown]> = [];
  const state = {
    sessionKey: SESSION,
    connected: true,
    chatRunId: null as string | null,
    hello: null,
    requestUpdate: vi.fn(),
    client: {
      request: vi.fn(async (method: string, params: Record<string, unknown>) => {
        requests.push([method, params]);
        if (method === "acpx.chat.handoff.get") {
          return {
            binding: options.bound === false ? null : { agent: "junie", targetSessionKey: TARGET },
            handoff: null,
            agents: ["junie"],
          };
        }
        if (method === "acpx.chat.permissions.get") {
          return { targetSessionKey: TARGET, available: options.available !== false, mode };
        }
        if (method === "acpx.chat.permissions.set") {
          mode = String(params.mode);
          return { targetSessionKey: TARGET, mode };
        }
        throw new Error(`unexpected ${method}`);
      }),
    },
  } as unknown as ChatPageHost;
  return { state, requests };
}

async function settled(state: ChatPageHost) {
  await refreshChatHandoffInfo(state, SESSION);
  await refreshChatAcpPermissions(state, SESSION);
}

describe("composer Permissions toggle of a chat bound to an ACP agent", () => {
  it("shows Ask for a bound agent and switches it to Allow all and back", async () => {
    const { state, requests } = createChat();
    await settled(state);
    const toggle = buildChatAcpPermissionToggle({
      state,
      sessionKey: SESSION,
      agentLabel: "Junie",
      canWrite: true,
    });
    expect(toggle).toEqual(
      expect.objectContaining({ agent: "Junie", mode: "ask", pending: false, disabled: false }),
    );
    await toggle!.onSelect("allow-all");
    expect(requests).toContainEqual([
      "acpx.chat.permissions.set",
      { sessionKey: SESSION, mode: "allow-all" },
    ]);
    const after = buildChatAcpPermissionToggle({
      state,
      sessionKey: SESSION,
      agentLabel: "Junie",
      canWrite: true,
    });
    expect(after?.mode).toBe("allow-all");
    await after!.onSelect("ask");
    expect(
      buildChatAcpPermissionToggle({
        state,
        sessionKey: SESSION,
        agentLabel: "Junie",
        canWrite: true,
      })?.mode,
    ).toBe("ask");
  });

  it("is absent without a bound agent or where the agent's questions never reach the chat", async () => {
    for (const options of [{ bound: false }, { available: false }]) {
      const { state } = createChat(options);
      await settled(state);
      expect(
        buildChatAcpPermissionToggle({
          state,
          sessionKey: SESSION,
          agentLabel: "Junie",
          canWrite: true,
        }),
      ).toBeUndefined();
    }
  });

  it("is disabled without write access", async () => {
    const { state } = createChat();
    await settled(state);
    expect(
      buildChatAcpPermissionToggle({
        state,
        sessionKey: SESSION,
        agentLabel: "Junie",
        canWrite: false,
      })?.disabled,
    ).toBe(true);
  });

  it("re-reads the mode when a chat run starts or ends (Allow all pressed in a question)", async () => {
    const { state, requests } = createChat();
    await settled(state);
    const reads = () => requests.filter(([method]) => method === "acpx.chat.permissions.get");
    buildChatAcpPermissionToggle({
      state,
      sessionKey: SESSION,
      agentLabel: "Junie",
      canWrite: true,
    });
    expect(reads()).toHaveLength(1);
    (state as { chatRunId: string | null }).chatRunId = "run-1";
    buildChatAcpPermissionToggle({
      state,
      sessionKey: SESSION,
      agentLabel: "Junie",
      canWrite: true,
    });
    await vi.waitFor(() => expect(reads()).toHaveLength(2));
  });
});
