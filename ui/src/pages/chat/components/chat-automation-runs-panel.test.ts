/* @vitest-environment jsdom */
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { CronJob, CronRunLogEntry } from "../../../api/types.ts";
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
import { nothing } from "lit";
import { renderChatAutomationHeaderControl } from "./chat-automation-header-control.tsx";
import "./chat-automation-runs-panel.tsx";

const confirmDialog = vi.hoisted(() => vi.fn(async () => true));
vi.mock("../../../components/confirm-dialog.ts", () => ({ showConfirmDialog: confirmDialog }));

const CRON_METHODS = ["cron.list", "cron.runs", "cron.history", "cron.run"];
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

function job(id: string, patch: Partial<CronJob> = {}): CronJob {
  return {
    id,
    name: id === "job-1" ? "Morning digest" : id,
    sessionTarget: "isolated",
    state: {},
    ...patch,
  } as CronJob;
}

/** `cron.list` page with the chat's own job, plus whatever else the test adds. */
function listJobs(...jobs: CronJob[]) {
  return { jobs, total: jobs.length, offset: 0, hasMore: false, nextOffset: null };
}

async function settle(panel: HTMLElement & { updateComplete: Promise<unknown> }) {
  for (let index = 0; index < 4; index += 1) {
    await Promise.resolve();
    await panel.updateComplete;
  }
}

function mountPanel(
  read: (method: string, params: Record<string, unknown>) => unknown,
  scopes = ["operator.read"],
) {
  const request = vi.fn(async (method: string, params?: unknown) =>
    read(method, (params ?? {}) as Record<string, unknown>),
  );
  const client = createTestGatewayClient(request as never);
  const connection = createGatewayHarness(client);
  // The sidebar harness answers cron.list itself; this panel's job list comes from the test.
  const harnessRequest = client.request.bind(client);
  client.request = (async (method: string, params?: unknown) =>
    method === "cron.list" ? request(method, params) : harnessRequest(method, params)) as never;
  connection.publish({ hello: gatewayHelloForMethods(CRON_METHODS, scopes) });
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
      if (method === "cron.list") {
        return listJobs(job("job-1"));
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
      expect.objectContaining({
        scope: "all",
        sessionKey: JOB_KEY,
        limit: 20,
        offset: 0,
        sortDir: "desc",
      }),
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
      expect.objectContaining({ scope: "all", sessionKey: JOB_KEY, offset: 2 }),
    );
    expect(rows().map((row) => row.dataset.runStatus)).toEqual(["ok", "error", "skipped"]);
    expect(panel.querySelector(".chat-automation-runs__more")).toBeNull();
  });

  it("opens the selected run's transcript through cron.history and links to Automations", async () => {
    const { panel, request, navigate } = mountPanel((method) => {
      if (method === "cron.list") {
        return listJobs(job("job-1"));
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
      if (method === "cron.list") {
        return listJobs(job("job-other"));
      }
      if (method === "cron.runs") {
        return { entries: [], total: 0, offset: 0, hasMore: false };
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
      "cron.list",
      "cron.runs",
    ]);
  });

  it("switches to the note when the automation is removed while open", async () => {
    let removed = false;
    const { panel, connection } = mountPanel((method) => {
      if (method === "cron.list") {
        return removed ? listJobs() : listJobs(job("job-1"));
      }
      return { entries: [run(0)], total: 1, offset: 0, hasMore: false };
    });
    await settle(panel);
    expect(panel.querySelectorAll(".chat-automation-runs__run")).toHaveLength(1);
    removed = true;
    connection.publishEvent("cron", { jobId: "job-1", action: "removed" });
    await settle(panel);
    expect(panel.querySelector('[data-test-id="automation-runs-deleted"]')).not.toBeNull();
    expect(panel.querySelector(".chat-automation-runs__run")).toBeNull();
  });
});

describe("automation chat with jobs that target it by session", () => {
  const followUp = job("job-follow", {
    name: "Night follow-up",
    sessionTarget: `session:${JOB_KEY}`,
  } as Partial<CronJob>);

  it("lists their runs with the job name and opens them under their own job", async () => {
    const { panel, request } = mountPanel((method) => {
      if (method === "cron.list") {
        return listJobs(followUp, job("job-1"), job("job-unrelated"));
      }
      if (method === "cron.runs") {
        return {
          entries: [
            run(0, { jobId: "job-follow", sessionKey: JOB_KEY, runId: "follow-0" }),
            run(1),
            run(2, { jobId: "job-gone", jobName: "Removed one-shot", sessionKey: JOB_KEY }),
          ],
          total: 3,
          offset: 0,
          hasMore: false,
        };
      }
      if (method === "cron.history") {
        return { messages: [{ role: "assistant", content: "Follow-up output" }] };
      }
      throw new Error(`unexpected ${method}`);
    });
    await settle(panel);
    const names = [...panel.querySelectorAll('[data-test-id="automation-run-job"]')].map(
      (node) => node.textContent,
    );
    expect(names).toEqual(["Night follow-up", "Morning digest", "Removed one-shot"]);
    panel.querySelectorAll<HTMLButtonElement>(".chat-automation-runs__run")[0]!.click();
    await vi.waitFor(() => expect(panel.textContent).toContain("Follow-up output"));
    expect(request).toHaveBeenCalledWith(
      "cron.history",
      expect.objectContaining({ id: "job-follow", runId: "follow-0" }),
    );
    expect(
      panel
        .querySelector('[data-test-id="automation-runs-open-in-automations"]')
        ?.getAttribute("href"),
    ).toBe("/ui/automations?job=job-follow&run=follow-0");
  });

  it("offers a menu of every job that delivers here, for admins only", async () => {
    const read = (method: string) =>
      method === "cron.list"
        ? listJobs(followUp, job("job-1"))
        : { entries: [], total: 0, offset: 0, hasMore: false };
    const viewer = mountPanel(read);
    await settle(viewer.panel);
    expect(viewer.panel.querySelector('[data-test-id="automation-run-menu"]')).toBeNull();
    viewer.panel.remove();

    const admin = mountPanel(read, ["operator.admin"]);
    await settle(admin.panel);
    expect(admin.panel.querySelector('[data-test-id="automation-run-menu"]')).not.toBeNull();
    const items = [...admin.panel.querySelectorAll("wa-dropdown-item")].map((item) =>
      item.getAttribute("value"),
    );
    expect(items).toEqual(["job-1", "job-follow"]);
  });
});

describe("automation chat Run button", () => {
  function mountWithJob(owner: CronJob, runResult: unknown = { ok: true, ran: true }) {
    return mountPanel(
      (method) => {
        if (method === "cron.list") {
          return listJobs(owner);
        }
        if (method === "cron.run") {
          return runResult;
        }
        return { entries: [], total: 0, offset: 0, hasMore: false };
      },
      ["operator.admin"],
    );
  }

  it("asks first, then starts the automation like Automations → Run", async () => {
    confirmDialog.mockClear();
    const { panel, request } = mountWithJob(job("job-1"));
    await settle(panel);
    const button = panel.querySelector<HTMLButtonElement>('[data-test-id="automation-run-now"]')!;
    expect(button.textContent).toContain("Run now");
    button.click();
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("cron.run", { id: "job-1", mode: "force" }),
    );
    expect(confirmDialog).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Run Morning digest now?" }),
    );
  });

  it("does not run when the confirmation is declined", async () => {
    confirmDialog.mockResolvedValueOnce(false);
    const { panel, request } = mountWithJob(job("job-1"));
    await settle(panel);
    panel.querySelector<HTMLButtonElement>('[data-test-id="automation-run-now"]')!.click();
    await settle(panel);
    expect(request.mock.calls.some(([method]) => method === "cron.run")).toBe(false);
  });

  it("reads Run again after a failed run and is disabled with a reason while running", async () => {
    const failed = mountWithJob(job("job-1", { state: { lastRunStatus: "error" } } as never));
    await settle(failed.panel);
    expect(
      failed.panel.querySelector('[data-test-id="automation-run-now"]')?.textContent,
    ).toContain("Run again");
    failed.panel.remove();

    const running = mountWithJob(job("job-1", { state: { runningAtMs: 1 } } as never));
    await settle(running.panel);
    const button = running.panel.querySelector<HTMLButtonElement>(
      '[data-test-id="automation-run-now"]',
    )!;
    expect(button.disabled).toBe(true);
    expect(button.textContent).toContain("Running…");
  });

  it("explains why a run did not start", async () => {
    const { panel } = mountWithJob(job("job-1"), {
      ok: true,
      ran: false,
      reason: "already-running",
    });
    await settle(panel);
    panel.querySelector<HTMLButtonElement>('[data-test-id="automation-run-now"]')!.click();
    await vi.waitFor(() =>
      expect(panel.querySelector(".chat-automation-run__feedback")?.textContent).toBeTruthy(),
    );
  });
});

describe("automation chat header", () => {
  const params = {
    sessionKey: JOB_KEY,
    agentId: "main",
    presented: true,
    runsAvailable: true,
    onOpenRuns: () => undefined,
  };

  it("adds Runs and Run controls only to an automation chat whose runs may be read", () => {
    expect(renderChatAutomationHeaderControl(params)).not.toBe(nothing);
    expect(renderChatAutomationHeaderControl({ ...params, runsAvailable: false })).toBe(nothing);
    expect(renderChatAutomationHeaderControl({ ...params, sessionKey: "agent:main:main" })).toBe(
      nothing,
    );
  });

  it("opens the Runs tab from the header and offers Run now there too", async () => {
    const { panel } = mountPanel(
      (method) =>
        method === "cron.list"
          ? listJobs(job("job-1"))
          : { entries: [], total: 0, offset: 0, hasMore: false },
      ["operator.admin"],
    );
    const header = document.createElement("openclaw-chat-automation-header-control");
    const onOpenRuns = vi.fn();
    header.sessionKey = JOB_KEY;
    header.onOpenRuns = onOpenRuns;
    panel.parentElement!.append(header);
    await settle(header);
    await vi.waitFor(() =>
      expect(header.querySelector('[data-test-id="automation-run-now"]')).not.toBeNull(),
    );
    header.querySelector<HTMLButtonElement>('[data-test-id="automation-header-runs"]')!.click();
    expect(onOpenRuns).toHaveBeenCalledOnce();
  });
});
