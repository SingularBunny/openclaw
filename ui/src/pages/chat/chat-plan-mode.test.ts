import { describe, expect, it, vi } from "vitest";

vi.mock("../../lib/gateway-methods.ts", () => ({ canCallGatewayMethod: () => true }));

import {
  buildChatPlanModeToggle,
  readChatPlanMode,
  refreshChatPlanMode,
  setChatPlanMode,
} from "./chat-plan-mode.ts";

function createHost(options: { failSet?: boolean } = {}) {
  const plans = new Set<string>();
  const requests: Array<[string, Record<string, unknown>]> = [];
  const host = {
    connected: true,
    hello: null,
    chatError: null as string | null,
    lastError: null as string | null,
    requestUpdate: vi.fn(),
    client: {
      request: vi.fn(async (method: string, params: Record<string, unknown>) => {
        requests.push([method, params]);
        const key = String(params.sessionKey);
        if (method === "aiwb-plan.set") {
          if (options.failSet) {
            throw new Error("denied");
          }
          if (params.on) {
            plans.add(key);
          } else {
            plans.delete(key);
          }
        }
        return { on: plans.has(key), since: null };
      }),
    },
  };
  return {
    host: host as never as Parameters<typeof setChatPlanMode>[0] & typeof host,
    plans,
    requests,
  };
}

describe("composer plan mode toggle", () => {
  it("loads the chat's plan mode once and shows it", async () => {
    const { host, plans, requests } = createHost();
    plans.add("agent:main:a");
    expect(buildChatPlanModeToggle(host, "agent:main:a")).toMatchObject({
      on: false,
      known: false,
    });
    buildChatPlanModeToggle(host, "agent:main:a");
    await vi.waitFor(() => expect(readChatPlanMode(host, "agent:main:a")).toEqual({ on: true }));
    expect(requests).toEqual([["aiwb-plan.status", { sessionKey: "agent:main:a" }]]);
    expect(buildChatPlanModeToggle(host, "agent:main:a")).toMatchObject({ on: true, known: true });
  });

  it("flips plan mode through the plugin method, as /plan and /plan off do", async () => {
    const { host, plans, requests } = createHost();
    const toggle = buildChatPlanModeToggle(host, "agent:main:b", "work")!;
    expect(await toggle.onToggle(true)).toBe(true);
    expect(plans.has("agent:main:b")).toBe(true);
    expect(requests).toContainEqual([
      "aiwb-plan.set",
      { sessionKey: "agent:main:b", agentId: "work", on: true },
    ]);
    expect(readChatPlanMode(host, "agent:main:b", "work")).toEqual({ on: true });
    // A typed /plan off (or an approved plan) is read back after the turn.
    plans.delete("agent:main:b");
    await refreshChatPlanMode(host, "agent:main:b", "work");
    expect(buildChatPlanModeToggle(host, "agent:main:b", "work")?.on).toBe(false);
  });

  it("keeps the state and reports the error when the switch fails", async () => {
    const { host } = createHost({ failSet: true });
    expect(await setChatPlanMode(host, "agent:main:c", undefined, true)).toBe(false);
    expect(host.chatError).toContain("denied");
    expect(readChatPlanMode(host, "agent:main:c")?.on ?? false).toBe(false);
  });
});
