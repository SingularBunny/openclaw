/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionCatalog } from "../../../packages/gateway-protocol/src/index.ts";
import type { GatewayBrowserClient, GatewayHelloOk } from "../api/gateway.ts";
import type { GatewaySessionRow, SessionsListResult } from "../api/types.ts";
import type { ApplicationContext } from "../app/context.ts";
import {
  createGatewayHarness,
  createTestSessionCapability,
  sessionsResult,
} from "../lib/sessions/session-capability.test-support.ts";
import { SessionCatalogStatusRows } from "./session-catalog-status-rows.ts";

const SESSION_EVENT_REFRESH_DEBOUNCE_MS = 5_000;

function catalog(sessionKeys: string[]): SessionCatalog {
  return {
    id: "projects",
    label: "Projects",
    capabilities: { continueSession: true, archive: true },
    hosts: [
      {
        hostId: "gateway:local",
        label: "Projects",
        kind: "gateway",
        connected: true,
        sessions: sessionKeys.map((sessionKey) => ({
          threadId: sessionKey,
          name: sessionKey,
          status: "stored",
          archived: false,
          sessionKey,
          canContinue: true,
          canArchive: true,
        })),
      },
    ],
  };
}

const alpha: GatewaySessionRow = {
  key: "agent:main:alpha",
  sessionId: "alpha-session",
  kind: "direct",
  updatedAt: 10,
  unread: true,
};
const beta: GatewaySessionRow = {
  key: "agent:research:beta",
  sessionId: "beta-session",
  kind: "direct",
  updatedAt: 20,
  status: "running",
  hasActiveRun: true,
  activeRunIds: ["run-beta"],
};

function fixture(methods: string[] = ["sessions.list"]) {
  const lists: Array<Record<string, unknown> | undefined> = [];
  let next: SessionsListResult = sessionsResult([beta, alpha], 1);
  const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === "sessions.subscribe") {
      return { subscribed: true };
    }
    if (method === "sessions.list") {
      lists.push(params);
      return next;
    }
    return {};
  });
  const harness = createGatewayHarness({ request } as unknown as GatewayBrowserClient, methods);
  const snapshot = harness.gateway.snapshot;
  if (snapshot.hello) {
    snapshot.hello = {
      ...snapshot.hello,
      auth: { role: "operator", scopes: ["operator.read"] },
    } as GatewayHelloOk;
  }
  const sessions = createTestSessionCapability(harness.gateway);
  const context = { gateway: harness.gateway, sessions } as unknown as ApplicationContext;
  const requestSessionDataUpdate = vi.fn();
  const rows = new SessionCatalogStatusRows({
    context,
    sessionDataHostConnected: true,
    requestSessionDataUpdate,
  });
  return {
    rows,
    lists,
    emitEvent: harness.emitEvent,
    requestSessionDataUpdate,
    respondWith: (result: SessionsListResult) => {
      next = result;
    },
  };
}

describe("SessionCatalogStatusRows (F58)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("stays idle without catalog sessions or without sessions.list access", async () => {
    const idle = fixture();
    idle.rows.synchronize([catalog([])]);
    const unadvertised = fixture([]);
    unadvertised.rows.synchronize([catalog([alpha.key])]);
    await vi.advanceTimersByTimeAsync(0);

    expect(idle.lists).toEqual([]);
    expect(unadvertised.lists).toEqual([]);
    expect(idle.rows.rows).toEqual([]);
  });

  it("reads one all-agent window and follows session events of every agent", async () => {
    const { rows, lists, emitEvent, requestSessionDataUpdate, respondWith } = fixture();
    rows.synchronize([catalog([alpha.key, beta.key])]);
    await vi.advanceTimersByTimeAsync(0);

    const initialReads = lists.length;
    expect(initialReads).toBeGreaterThan(0);
    expect(lists[0]).toMatchObject({ rowMode: "sidebar", excludeDock: true, limit: 200 });
    expect(lists[0]).not.toHaveProperty("agentId");
    expect(lists[0]).not.toHaveProperty("archived");
    expect(rows.rows.map((row) => row.key)).toEqual([beta.key, alpha.key]);
    expect(requestSessionDataUpdate).toHaveBeenCalled();

    // Repeated synchronization (every sidebar update) keeps the one observation.
    rows.synchronize([catalog([alpha.key, beta.key])]);
    await vi.advanceTimersByTimeAsync(0);
    expect(lists).toHaveLength(initialReads);

    // The research run ends while the sidebar shows another agent.
    const finished: GatewaySessionRow = {
      ...beta,
      updatedAt: 30,
      status: "done",
      hasActiveRun: false,
      activeRunIds: [],
      unread: true,
    };
    respondWith(sessionsResult([finished, alpha], 2));
    emitEvent({
      type: "event",
      event: "sessions.changed",
      payload: { sessionKey: beta.key, agentId: "research", reason: "update" },
    });
    await vi.advanceTimersByTimeAsync(SESSION_EVENT_REFRESH_DEBOUNCE_MS);

    const updated = rows.rows.find((row) => row.key === beta.key);
    expect(updated).toMatchObject({ hasActiveRun: false, unread: true });
    // One paced re-read for the event, never one per row or per agent.
    expect(lists.every((params) => params?.agentId === undefined)).toBe(true);
  });

  it("drops its rows once no catalog adopts a session", async () => {
    const { rows, requestSessionDataUpdate } = fixture();
    rows.synchronize([catalog([alpha.key])]);
    await vi.advanceTimersByTimeAsync(0);
    expect(rows.rows).toHaveLength(2);

    requestSessionDataUpdate.mockClear();
    rows.synchronize([]);
    expect(rows.rows).toEqual([]);
    expect(requestSessionDataUpdate).toHaveBeenCalledOnce();
    rows.dispose();
  });
});
