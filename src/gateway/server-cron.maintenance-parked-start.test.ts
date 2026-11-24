// Fork: a cron start parked by maintenance must not count as running work in maintenance status.
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliDeps } from "../cli/deps.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { CronService } from "../cron/service.js";
import { resolveCronJobsStorePathFromConfigAsync } from "../cron/store.js";
import {
  enterGatewayMaintenance,
  exitGatewayMaintenance,
  resetGatewayMaintenanceForTest,
} from "../process/gateway-maintenance-mode.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";

const { getRuntimeConfigMock } = vi.hoisted(() => ({ getRuntimeConfigMock: vi.fn() }));

vi.mock("../config/io.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/io.js")>()),
  getRuntimeConfig: getRuntimeConfigMock,
}));

vi.mock("./cron-exit-watchers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./cron-exit-watchers.js")>()),
  createCronExitWatchers: () => ({
    reconcile: vi.fn(),
    cancel: vi.fn(),
    cancelAll: vi.fn(async () => {}),
    activeJobIds: () => [],
    updateHandlers: vi.fn(),
  }),
}));

vi.mock("./cron-stream-watchers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./cron-stream-watchers.js")>()),
  createCronStreamWatchers: () => ({
    reconcile: vi.fn(async () => {}),
    resume: vi.fn(),
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    stopAll: vi.fn(async () => {}),
    activeJobIds: () => [],
    inspect: () => undefined,
  }),
}));

import { buildGatewayCronService } from "./server-cron.js";
import { readGatewayMaintenanceStatus } from "./server-methods/maintenance-mode.js";

describe("cron start parked by maintenance", () => {
  let stateDir: string;
  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-cron-maint-parked-"));
    resetGatewayMaintenanceForTest(path.join(stateDir, "gateway-maintenance.json"));
  });
  afterEach(async () => {
    resetGatewayMaintenanceForTest();
    await rm(stateDir, { recursive: true, force: true });
  });

  it("does not hold maintenance status busy while the start waits for maintenance to end", async () => {
    const cfg: OpenClawConfig = { session: { mainKey: "main" }, cron: { enabled: true } };
    getRuntimeConfigMock.mockReturnValue(cfg);
    const env = { ...process.env, OPENCLAW_SKIP_CRON: "0", OPENCLAW_STATE_DIR: stateDir };
    // The persisted maintenance state is already on when the Gateway builds its cron service.
    enterGatewayMaintenance({ source: "installer", reason: "OpenClaw update" });
    // The Gateway wrapper binds the service start when it is built.
    const serviceStart = vi.spyOn(CronService.prototype, "start");
    const state = buildGatewayCronService({
      storePath: await resolveCronJobsStorePathFromConfigAsync(cfg, env),
      scheduler: createTestGatewayScheduler(createGatewaySchedulerClock(Date.now()).clock),
      cfg,
      deps: {} as CliDeps,
      broadcast: () => {},
      env,
    });
    const context = {
      cron: state.cron,
      terminalSessions: new Map(),
    } as unknown as Parameters<typeof readGatewayMaintenanceStatus>[0];
    try {
      // Post-ready startup starts cron; paused scheduling parks it until maintenance ends.
      let startSettled = false;
      const start = state.cron.start().then(() => {
        startSettled = true;
      });
      await nextTurn();
      expect(serviceStart).not.toHaveBeenCalled();
      expect(startSettled).toBe(false);
      // Host suspension still sees the pending start (upstream contract)...
      expect(state.cron.getSuspensionBlockerCount?.()).toBe(1);
      // ...but the installer's maintenance wait must not: nothing is running.
      const status = readGatewayMaintenanceStatus(context);
      expect(status).toMatchObject({ active: true, activeTurns: 0, activeWork: 0, blockers: [] });

      exitGatewayMaintenance();
      await start;
      expect(serviceStart).toHaveBeenCalledOnce();
      expect(state.cron.getParkedStartCount?.()).toBe(0);
      expect(readGatewayMaintenanceStatus(context).active).toBe(false);
    } finally {
      serviceStart.mockRestore();
      await state.cron.stopAndDrain?.();
    }
  });
});
