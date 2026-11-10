/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewaySessionRow, SessionsListResult } from "../api/types.ts";
import type { ApplicationGatewaySnapshot } from "../app/context.ts";
import type { SessionCapability, SessionListSnapshot } from "../lib/sessions/index.ts";
import {
  catalogPage,
  createGatewayHarness,
  createSessions,
  mountSidebar,
  TWO_AGENTS,
  type SidebarLifecycleState,
} from "../test-helpers/app-sidebar.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../test-helpers/gateway-client.ts";
import "../test-helpers/app-sidebar-suite.ts";
import { settleLitElement } from "../test-helpers/lit-settle.ts";
import "./app-sidebar.tsx";

const ALPHA = "agent:main:alpha";
const BETA = "agent:research:beta";

function statusResult(rows: GatewaySessionRow[]): SessionsListResult {
  return {
    ts: 1,
    path: "",
    count: rows.length,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions: rows,
  };
}

async function settle(sidebar: SidebarLifecycleState) {
  await vi.advanceTimersByTimeAsync(0);
  await settleLitElement(sidebar);
}

function catalogRow(sidebar: SidebarLifecycleState, key: string) {
  return sidebar.querySelector<HTMLElement>(
    `[data-session-section="catalog:codex"] [data-session-key="${key}"]`,
  );
}

function markers(sidebar: SidebarLifecycleState, key: string) {
  const row = catalogRow(sidebar, key);
  return {
    present: row !== null,
    running:
      row?.matches(".session-row-host--running") === true &&
      row.querySelector(".sidebar-session-indicator .session-glyph__ring") !== null,
    unread: row?.querySelector(".sidebar-session-indicator .session-unread-dot") != null,
  };
}

// Fork (F58): the Projects catalog lists every agent's chats, while the sidebar session list holds
// only the selected agent. Rows of the other agents keep their live markers from one all-agent
// status window, before and after an agent switch.
describe("AppSidebar catalog status rows across agents", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("keeps running and unread markers on other agents' rows and follows their updates", async () => {
    const request = createGatewayRequestMock(async (method) =>
      method === "sessions.catalog.list"
        ? catalogPage([
            { threadId: "alpha", name: "Alpha chat", sessionKey: ALPHA },
            { threadId: "beta", name: "Beta chat", sessionKey: BETA },
          ])
        : {},
    );
    const gateway = createGatewayHarness(createTestGatewayClient(request));
    gateway.publish({
      hello: {
        auth: { role: "operator", scopes: ["operator.read"] },
        features: {
          methods: ["sessions.catalog.list", "sessions.list"],
          events: ["sessions.catalog.changed"],
        },
      } as ApplicationGatewaySnapshot["hello"],
    });
    const sessions = createSessions("main", ["agent:main:main"]);
    // The all-agent window is the capability's managed list; the fake stands in for its reads
    // and for the event reconciliation that republishes it.
    let publishStatus: ((snapshot: SessionListSnapshot) => void) | undefined;
    let current = statusResult([
      { key: ALPHA, kind: "direct", sessionId: "alpha-session", unread: true },
      {
        key: BETA,
        kind: "direct",
        sessionId: "beta-session",
        status: "running",
        hasActiveRun: true,
        activeRunIds: ["run-beta"],
      },
    ]);
    const observed: Parameters<SessionCapability["observeList"]>[0][] = [];
    const observeList: SessionCapability["observeList"] = (scope, listener) => {
      observed.push(scope);
      publishStatus = listener;
      listener({ result: null, agentId: null, loading: false, error: null });
      return {
        refresh: async () =>
          listener({ result: current, agentId: null, loading: false, error: null }),
        dispose: () => {
          publishStatus = undefined;
        },
      };
    };
    Object.assign(sessions, { observeList });

    const { sidebar, context } = await mountSidebar(gateway.gateway, sessions, "panel", TWO_AGENTS);
    sidebar.connected = true;
    await sidebar.updateComplete;
    await settle(sidebar);

    expect(observed).toHaveLength(1);
    expect(observed[0]?.agentId).toBeUndefined();
    // Main is selected: the research row is another agent's, yet it shows its run.
    expect(markers(sidebar, BETA)).toEqual({ present: true, running: true, unread: false });
    expect(markers(sidebar, ALPHA)).toEqual({ present: true, running: false, unread: true });

    context.agentSelection.state.selectedId = "research";
    context.agentSelection.state.scopeId = "research";
    sidebar.requestUpdate();
    await settleLitElement(sidebar);
    await vi.advanceTimersByTimeAsync(200);
    await settle(sidebar);

    // After the switch the main row belongs to a non-selected agent and keeps its unread marker.
    expect(markers(sidebar, ALPHA)).toEqual({ present: true, running: false, unread: true });
    expect(markers(sidebar, BETA)).toEqual({ present: true, running: true, unread: false });
    expect(observed).toHaveLength(1);

    // A session event reconciles the window: the research run ends and leaves an unread reply,
    // and the main chat is read elsewhere.
    current = statusResult([
      { key: ALPHA, kind: "direct", sessionId: "alpha-session", unread: false },
      {
        key: BETA,
        kind: "direct",
        sessionId: "beta-session",
        status: "done",
        hasActiveRun: false,
        activeRunIds: [],
        unread: true,
      },
    ]);
    publishStatus?.({ result: current, agentId: null, loading: false, error: null });
    await settle(sidebar);

    expect(markers(sidebar, BETA)).toEqual({ present: true, running: false, unread: true });
    expect(markers(sidebar, ALPHA)).toEqual({ present: true, running: false, unread: false });
  });
});
