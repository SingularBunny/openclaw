import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { toPublicCronJob } from "./public-job.js";
import {
  createCronServiceWithStateForTest,
  setupCronServiceSuite,
} from "./service.test-harness.js";
import type { CronServiceDeps } from "./service/state.js";
import { MIN_REFIRE_GAP_MS } from "./service/timer-execution-timeout.js";
import { loadCronStore } from "./store.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-follow-up-chain-",
  fakeTimers: false,
});
let clock: ReturnType<typeof createGatewaySchedulerClock>;
let storePath: string;
beforeEach(async () => {
  ({ storePath } = await makeStorePath());
  clock = createGatewaySchedulerClock(Date.parse("2026-11-17T17:00:00.000Z"));
});

describe("cron follow-up chain depth", () => {
  it("carries the accepted depth across firings of the rearmed one-shot", async () => {
    const delayMs = 20 * 60_000;
    const runSessionEvent = vi
      .fn<NonNullable<CronServiceDeps["runSessionEvent"]>>()
      .mockResolvedValueOnce({
        status: "ok",
        summary: "DAG 1 restarted",
        nextCheck: { delayMs, followUpDepth: 1 },
      })
      .mockResolvedValueOnce({
        status: "ok",
        summary: "DAG 2 restarted",
        nextCheck: { delayMs, followUpDepth: 2 },
      })
      .mockResolvedValueOnce({ status: "ok", summary: "upstream rearm", nextCheck: { delayMs } })
      .mockResolvedValue({ status: "ok", summary: "done" });
    const { cron } = createCronServiceWithStateForTest({
      scheduler: createTestGatewayScheduler(clock.clock),
      storePath,
      cronEnabled: true,
      log: logger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      runSessionEvent,
    });
    try {
      await cron.start();
      cron.pauseScheduling();
      let atMs = clock.clock.now() + 1_000;
      const job = await cron.add({
        name: "Restart queue",
        enabled: true,
        deleteAfterRun: true,
        schedule: { kind: "at", at: new Date(atMs).toISOString() },
        sessionTarget: "session:agent:main:cron:origin-job",
        wakeMode: "next-heartbeat",
        payload: {
          kind: "agentTurn",
          message: "Restart the next DAG.",
          toolsAllow: ["automations"],
        },
        delivery: { mode: "none" },
      });
      const storedDepth = async () =>
        (await loadCronStore(storePath)).jobs.find((entry) => entry.id === job.id)?.state
          .followUpDepth;
      expect(await storedDepth()).toBeUndefined();

      for (const expected of [1, 2, 2]) {
        clock.setTime(atMs);
        await cron.run(job.id, "due");
        expect(await storedDepth()).toBe(expected);
        const stored = (await loadCronStore(storePath)).jobs.find((entry) => entry.id === job.id);
        expect(toPublicCronJob(stored!).state).not.toHaveProperty("followUpDepth");
        atMs = atMs + Math.max(MIN_REFIRE_GAP_MS, delayMs);
        expect(stored?.state.nextRunAtMs).toBe(atMs);
      }
    } finally {
      cron.stop();
    }
  });
});
