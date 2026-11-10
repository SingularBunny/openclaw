/* @vitest-environment jsdom */
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { GatewayRequestError } from "../../../api/gateway.ts";
import type { CronRunLogEntry } from "../../../api/types.ts";
import type { ApplicationContext } from "../../../app/context.ts";
import { automationSessionJobId } from "../../../lib/cron/automation-session.ts";
import { createTestSessionCapability } from "../../../lib/sessions/session-capability.test-support.ts";
import { disposeSidebarContextLifecycles } from "../../../test-helpers/app-sidebar-context-lifecycle.ts";
import { createContext, createGatewayHarness } from "../../../test-helpers/app-sidebar.ts";
import { createApplicationContextProvider } from "../../../test-helpers/application-context.ts";
import { createReviewFixture } from "../../../test-helpers/chat-pane-embedded-panels.ts";
import { createTestGatewayClient } from "../../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../../test-helpers/gateway-methods.ts";
import { sidebarPanelDefinitions } from "../chat-pane-embedded-panels.ts";
import "./chat-automation-runs-panel.tsx";

const CRON_METHODS = ["cron.get", "cron.runs", "cron.history"];
const JOB_KEY = "agent:main:cron:job-1";

function run(index: number, patch: Partial<CronRunLogEntry> = {}): CronRunLogEntry {
  return {
    ts: 10_000 - index,
    jobId: "job-1",
    action: "finished",
    status: "ok",
    runAtMs: 9_000 - index,
    durationMs: 65_000,
    runId: `run-${index}`,
    sessionKey: `${JOB_KEY}:run:run-${index}`,
    ...patch,
  } as CronRunLogEntry;
}

function notFound() {
  return new GatewayRequestError({
    code: "INVALID_REQUEST",
    message: "Automation not found: job-1.",
    details: { code: "CRON_JOB_NOT_FOUND", jobId: "job-1" },
  });
}

async function settle(panel: HTMLElement & { updateComplete: Promise<unknown> }) {
  for (let index = 0; index < 4; index += 1) {
    await Promise.resolve();
    await panel.updateComplete;
  }
}

function mountPanel(read: (method: string, params: Record<string, unknown>) => unknown) {
  const request = vi.fn(async (method: string, params?: unknown) =>
    read(method, (params ?? {}) as Record<string, unknown>),
  );
  const client = createTestGatewayClient(request as never);
  const connection = createGatewayHarness(client);
  connection.publish({ hello: gatewayHelloForMethods(CRON_METHODS, ["operator.read"]) });
  const sessions = createTestSessionCapability(connection.gateway);
  const navigate = vi.fn();
  const context = {
    ...createContext(connection.gateway, sessions),
    basePath: "/ui",
    navigate,
  } as ApplicationContext;
  const provider = createApplicationContextProvider(context);
  const panel = document.createElement("openclaw-chat-automation-runs-panel");
  panel.sessionKey = JOB_KEY;
  provider.append(panel);
  document.body.append(provider);
  onTestFinished(() => {
    provider.remove();
    sessions.dispose();
    disposeSidebarContextLifecycles();
  });
  return { panel, request, navigate, connection };
}

describe("automation session detection", () => {
  it("finds the job only in isolated automation chats", () => {
    expect(automationSessionJobId(JOB_KEY)).toBe("job-1");
    expect(automationSessionJobId(`${JOB_KEY}:run:abc`)).toBe("job-1");
    expect(automationSessionJobId("agent:main:main")).toBeNull();
    expect(automationSessionJobId("agent:main:subagent:cron:x")).toBeNull();
    expect(automationSessionJobId("cron:job-1")).toBeNull();
    expect(automationSessionJobId(undefined)).toBeNull();
  });

  it("offers the Runs tab only for an automation chat that may read run history", () => {
    const { state } = createReviewFixture();
    const runsTab = () => {
      const definitions = sidebarPanelDefinitions({
        state,
        renderDetail: vi.fn(),
      } as unknown as Parameters<typeof sidebarPanelDefinitions>[0]);
      return definitions.find((definition) => definition.slot === "runs");
    };
    state.hello = gatewayHelloForMethods(CRON_METHODS, ["operator.read"]);
    state.sessionKey = JOB_KEY;
    expect(runsTab()?.available).toBe(true);
    expect(runsTab()?.label).toBe("Runs");
    expect(runsTab()?.content).not.toBeNull();

    state.sessionKey = "agent:main:main";
    expect(runsTab()?.available).toBe(false);
    expect(runsTab()?.content).toBeNull();

    state.sessionKey = JOB_KEY;
    state.hello = gatewayHelloForMethods(["cron.get"], ["operator.read"]);
    expect(runsTab()?.available).toBe(false);
  });
});

describe("automation runs panel", () => {
  it("lists runs newest first with status, duration and error, and loads more", async () => {
    const { panel, request } = mountPanel((method, params) => {
      if (method === "cron.get") {
        return { id: "job-1", name: "Morning digest" };
      }
      if (method === "cron.runs") {
        return params.offset === 0
          ? {
              entries: [
                run(0),
                run(1, { status: "error", error: "Model request timed out", durationMs: 4_000 }),
              ],
              total: 3,
              offset: 0,
              limit: 20,
              hasMore: true,
              nextOffset: 2,
            }
          : { entries: [run(2, { status: "skipped" })], total: 3, offset: 2, hasMore: false };
      }
      throw new Error(`unexpected ${method}`);
    });
    await settle(panel);
    expect(request).toHaveBeenCalledWith(
      "cron.runs",
      expect.objectContaining({ scope: "job", id: "job-1", limit: 20, offset: 0, sortDir: "desc" }),
    );
    expect(panel.querySelector(".chat-automation-runs__name")?.textContent).toBe("Morning digest");
    const rows = () => [...panel.querySelectorAll<HTMLButtonElement>(".chat-automation-runs__run")];
    expect(rows().map((row) => row.dataset.runStatus)).toEqual(["ok", "error"]);
    expect(rows()[0]?.textContent).toContain("1m 5s");
    expect(rows()[1]?.textContent).toContain("Model request timed out");

    panel.querySelector<HTMLButtonElement>(".chat-automation-runs__more")!.click();
    await settle(panel);
    expect(request).toHaveBeenLastCalledWith(
      "cron.runs",
      expect.objectContaining({ id: "job-1", offset: 2 }),
    );
    expect(rows().map((row) => row.dataset.runStatus)).toEqual(["ok", "error", "skipped"]);
    expect(panel.querySelector(".chat-automation-runs__more")).toBeNull();
  });

  it("opens the selected run's transcript through cron.history and links to Automations", async () => {
    const { panel, request, navigate } = mountPanel((method) => {
      if (method === "cron.get") {
        return { id: "job-1", name: "Morning digest" };
      }
      if (method === "cron.runs") {
        return { entries: [run(0), run(1)], total: 2, offset: 0, hasMore: false };
      }
      if (method === "cron.history") {
        return { messages: [{ role: "assistant", content: "Exact retained output" }] };
      }
      throw new Error(`unexpected ${method}`);
    });
    await settle(panel);
    const link = () =>
      panel.querySelector<HTMLAnchorElement>(
        '[data-test-id="automation-runs-open-in-automations"]',
      );
    expect(link()?.getAttribute("href")).toBe("/ui/automations?job=job-1");

    panel.querySelectorAll<HTMLButtonElement>(".chat-automation-runs__run")[1]!.click();
    await vi.waitFor(() => expect(panel.textContent).toContain("Exact retained output"));
    expect(request).toHaveBeenCalledWith("cron.history", {
      id: "job-1",
      runId: "run-1",
      limit: 100,
    });
    expect(panel.querySelector<HTMLElement>(".chat-automation-runs__list")?.hidden).toBe(true);
    expect(link()?.getAttribute("href")).toBe("/ui/automations?job=job-1&run=run-1");

    link()!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    expect(navigate).toHaveBeenCalledWith("cron", { search: "?job=job-1&run=run-1" });

    [...panel.querySelectorAll<HTMLButtonElement>("[data-cron-run-transcript] button")]
      .find((button) => button.textContent?.trim() === "Close")!
      .click();
    await settle(panel);
    expect(panel.querySelector("[data-cron-run-transcript]")).toBeNull();
    expect(panel.querySelector<HTMLElement>(".chat-automation-runs__list")?.hidden).toBe(false);
  });

  it("shows a short note without errors when the automation was deleted", async () => {
    const { panel, request } = mountPanel((method) => {
      if (method === "cron.get" || method === "cron.runs") {
        throw notFound();
      }
      throw new Error(`unexpected ${method}`);
    });
    await settle(panel);
    expect(panel.querySelector('[data-test-id="automation-runs-deleted"]')?.textContent).toContain(
      "This automation was deleted",
    );
    expect(panel.querySelector('[role="alert"]')).toBeNull();
    expect(panel.querySelector('[data-test-id="automation-runs-open-in-automations"]')).toBeNull();
    expect(request.mock.calls.map(([method]) => method).toSorted()).toEqual([
      "cron.get",
      "cron.runs",
    ]);
  });

  it("switches to the note when the automation is removed while open", async () => {
    const { panel, connection } = mountPanel((method) => {
      if (method === "cron.get") {
        return { id: "job-1", name: "Morning digest" };
      }
      return { entries: [run(0)], total: 1, offset: 0, hasMore: false };
    });
    await settle(panel);
    expect(panel.querySelectorAll(".chat-automation-runs__run")).toHaveLength(1);
    connection.publishEvent("cron", { jobId: "job-1", action: "removed" });
    await settle(panel);
    expect(panel.querySelector('[data-test-id="automation-runs-deleted"]')).not.toBeNull();
    expect(panel.querySelector(".chat-automation-runs__run")).toBeNull();
  });
});
