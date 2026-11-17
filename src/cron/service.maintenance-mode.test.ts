// Fork: maintenance mode defers due cron jobs until it ends.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  enterGatewayMaintenance,
  exitGatewayMaintenance,
  isGatewayMaintenanceActive,
  resetGatewayMaintenanceForTest,
} from "../process/gateway-maintenance-mode.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import {
  createStartedCronServiceWithFinishedBarrier,
  createCronStoreHarness,
  createNoopLogger,
  installCronTestHooks,
} from "./service.test-harness.js";
import { waitForCronRunQueue } from "./service/run-queue.js";
import { captureCronSchedulerWakeForTest } from "./service/scheduler-actor.test-support.js";

const noopLogger = createNoopLogger();
const { makeStorePath } = createCronStoreHarness();
installCronTestHooks({ logger: noopLogger });

describe("cron in maintenance mode", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-cron-maint-"));
    resetGatewayMaintenanceForTest(path.join(dir, "gateway-maintenance.json"));
  });
  afterEach(() => {
    resetGatewayMaintenanceForTest();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("keeps a due job waiting during maintenance and runs it after", async () => {
    const store = await makeStorePath();
    const clock = createGatewaySchedulerClock(Date.now());
    const fixture = createStartedCronServiceWithFinishedBarrier({
      scheduler: createTestGatewayScheduler(clock.clock),
      storePath: store.storePath,
      logger: createNoopLogger(),
    });
    const { cron, state, enqueueSystemEvent, finished } = fixture;
    const { wake } = await captureCronSchedulerWakeForTest(() => cron.start());
    try {
      const job = await cron.add({
        name: "maintenance-tick",
        enabled: true,
        schedule: { kind: "every", everyMs: 10_000 },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "maintenance-tick" },
      });
      enterGatewayMaintenance({ source: "test" });
      cron.pauseScheduling();
      // A suspension ending meanwhile must not restart scheduling.
      cron.resumeScheduling();
      expect(state.schedulingPaused).toBe(true);

      clock.setTime(job.state.nextRunAtMs! + 5);
      await wake(state);
      await waitForCronRunQueue(state);
      expect(enqueueSystemEvent).not.toHaveBeenCalled();

      const finishedRun = finished.waitForOk(job.id);
      exitGatewayMaintenance();
      expect(isGatewayMaintenanceActive()).toBe(false);
      cron.resumeScheduling();
      await wake(state);
      await finishedRun;
      await waitForCronRunQueue(state);
      expect(enqueueSystemEvent.mock.calls.some(([text]) => text === "maintenance-tick")).toBe(
        true,
      );
    } finally {
      cron.stop();
      await store.cleanup();
    }
  });
});
