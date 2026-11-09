import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayActiveWorkSnapshot } from "../infra/gateway-active-work.js";
import * as restartModule from "../infra/restart.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import type { GatewayReloadPlan } from "./config-reload.js";
import {
  getGatewayRestartNotice,
  resetGatewayRestartNoticeForTest,
  setGatewayRestartNoticeBroadcaster,
} from "./restart-notice.js";
import { nextGatewayReloadGeneration } from "./server-reload-generation.js";
import { createGatewayRestartCoordinator } from "./server-reload-restart.js";

const getTotalQueueSize = vi.hoisted(() => vi.fn(() => 0));
vi.mock("../process/command-queue.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../process/command-queue.js")>()),
  getTotalQueueSize,
}));

const zeroActiveCounts = {
  queueSize: 0,
  pendingReplies: 0,
  embeddedRuns: 0,
  backgroundExecSessions: 0,
  rootRequests: 0,
  agentRuns: 0,
  acpRuns: 0,
  mediaRuns: 0,
  cronRuns: 0,
  sessionAdmissions: 0,
  sessionMutations: 0,
  chatRuns: 0,
  queuedTurns: 0,
  terminalPersistence: 0,
  terminalSessions: 0,
  lifecycleWrites: 0,
  totalActive: 0,
} satisfies GatewayActiveWorkSnapshot["counts"];

const restartPlan = {
  changedPaths: ["gateway.port"],
  restartGateway: true,
  restartReasons: ["gateway.port"],
  hotReasons: [],
  reloadHooks: false,
  restartGmailWatcher: false,
  restartCron: false,
  restartHeartbeat: false,
  reloadPlugins: false,
  restartChannels: new Set(),
  disposeMcpRuntimes: false,
  noopPaths: [],
} satisfies GatewayReloadPlan;

type CoordinatorOptions = Parameters<typeof createGatewayRestartCoordinator>[0];

function createCoordinator(
  {
    scheduler = createTestGatewayScheduler("fake-timers"),
    ...params
  }: Partial<CoordinatorOptions["params"]>,
  options: Partial<Omit<CoordinatorOptions, "params">> = {},
) {
  return createGatewayRestartCoordinator({
    params: { logReload: { info: vi.fn(), warn: vi.fn() }, ...params, scheduler },
    myGeneration: options.myGeneration ?? nextGatewayReloadGeneration(),
    restartRecoveryAvailable: true,
    getActiveCounts: () => zeroActiveCounts,
    formatActiveDetails: () => [],
    formatDeferredWorkStatus: () => "no active work",
    ...options,
  });
}

beforeEach(() => {
  getTotalQueueSize.mockReset().mockReturnValue(0);
  restartModule.resetGatewayRestartStateForInProcessRestart();
  resetGatewayWorkAdmission();
});

afterEach(() => {
  restartModule.resetGatewayRestartStateForInProcessRestart();
  resetGatewayWorkAdmission();
  vi.useRealTimers();
});

describe("gateway restart notice (fork)", () => {
  afterEach(() => resetGatewayRestartNoticeForTest());

  it("publishes the deferred restart, marks it restarting when ready, and clears it on supersede", () => {
    const events: unknown[] = [];
    setGatewayRestartNoticeBroadcaster((payload) => events.push(payload));
    const cancel = vi.fn();
    const deferSpy = vi.spyOn(restartModule, "deferGatewayRestartUntilIdle");
    let capturedHooks: Parameters<typeof restartModule.deferGatewayRestartUntilIdle>[0]["hooks"];
    deferSpy.mockImplementation(
      (opts: Parameters<typeof restartModule.deferGatewayRestartUntilIdle>[0]) => {
        capturedHooks = opts.hooks;
        return { cancel };
      },
    );
    // One chat turn shows in two overlapping registries: it is one running turn.
    const activeCounts = { ...zeroActiveCounts, totalActive: 3, agentRuns: 1, chatRuns: 1 };
    const coordinator = createCoordinator(
      { assertRestartReady: vi.fn(), requestRecoveryRestart: vi.fn() },
      { getActiveCounts: () => activeCounts },
    );
    try {
      coordinator.requestGatewayRestart(restartPlan, {} as OpenClawConfig);
      expect(getGatewayRestartNotice()).toMatchObject({
        phase: "pending",
        reason: "config reload: gateway.port",
        activeTurns: 1,
        activeWork: 3,
      });
      expect(events).toHaveLength(1);

      capturedHooks?.onReady?.();
      expect(getGatewayRestartNotice()?.phase).toBe("restarting");

      coordinator.requestGatewayRestart(restartPlan, {} as OpenClawConfig);
      expect(getGatewayRestartNotice()?.phase).toBe("pending");
      coordinator.stopRestartRetries();
      expect(getGatewayRestartNotice()).toBeNull();
      expect(events.at(-1)).toEqual({ notice: null });
    } finally {
      deferSpy.mockRestore();
      coordinator.stopRestartRetries();
    }
  });
});
