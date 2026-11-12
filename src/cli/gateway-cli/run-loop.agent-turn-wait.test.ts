import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayActiveWorkSnapshot } from "../../infra/gateway-active-work.js";
import {
  gatewayWorkAdmissionActual,
  runLoopFixture as fixture,
} from "./run-loop-mocks.test-support.js";

// Fork F44: a SIGTERM stop waits for running agent turns before the Gateway closes.
const work = vi.hoisted(() => ({ turns: 0 }));
vi.mock("../../infra/gateway-active-work.js", async (original) => {
  const actual = await original<typeof import("../../infra/gateway-active-work.js")>();
  return {
    ...actual,
    createGatewayActiveWorkSnapshot: (
      inspectors: Parameters<typeof actual.createGatewayActiveWorkSnapshot>[0] = {},
    ) => {
      // The run-loop fixture mocks the cron registries.
      const snapshot = actual.createGatewayActiveWorkSnapshot({
        getCronRuns: () => 0,
        ...inspectors,
      });
      if (work.turns === 0) {
        return snapshot;
      }
      return {
        ...snapshot,
        idle: false,
        counts: {
          ...snapshot.counts,
          embeddedRuns: work.turns,
          totalActive: snapshot.counts.totalActive + work.turns,
        },
        blockers: [
          ...snapshot.blockers,
          {
            kind: "embedded-run",
            count: work.turns,
            message: `${work.turns} active embedded run(s)`,
          },
        ],
      } satisfies GatewayActiveWorkSnapshot;
    },
  };
});

// The wait imports these lazily; load them before the cases' short deadlines.
await import("../../infra/gateway-active-work.js");
await import("../../sessions/session-controller.queries.js");
await import("../../gateway/restart-notice.js");

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitForWarning(text: string) {
  const deadline = Date.now() + 10_000;
  while (!fixture.gatewayLog.warn.mock.calls.some(([line]) => String(line).includes(text))) {
    if (Date.now() > deadline) {
      throw new Error(`the stop did not start waiting for the agent turn: ${text}`);
    }
    await sleep(20);
  }
}

afterEach(() => {
  work.turns = 0;
  vi.unstubAllEnvs();
});

describe("Gateway stop with OPENCLAW_RESTART_AGENT_RUN_WAIT_MS", () => {
  it("SIGTERM keeps admission closed and waits for a running agent turn before closing", async () => {
    vi.stubEnv("OPENCLAW_RESTART_AGENT_RUN_WAIT_MS", "1800000");
    work.turns = 1;
    await fixture.withRunningGateway(async ({ captureSignal, close, loopPromise }) => {
      captureSignal("SIGTERM")();
      await waitForWarning("for 1 running agent turn(s) (1 active embedded run(s))");
      await sleep(600);
      expect(close).not.toHaveBeenCalled();
      expect(gatewayWorkAdmissionActual.isGatewayWorkAdmissionClosed()).toBe(true);
      work.turns = 0;
      await expect(loopPromise).resolves.toBe(0);
      expect(close).toHaveBeenCalledOnce();
      expect(fixture.gatewayLog.info).toHaveBeenCalledWith(
        expect.stringMatching(/^running agent turns finished after \d+ms; continuing stop$/),
      );
    }, true);
  });

  it("a second SIGTERM stops waiting and closes with the turn still running", async () => {
    vi.stubEnv("OPENCLAW_RESTART_AGENT_RUN_WAIT_MS", "1800000");
    work.turns = 1;
    await fixture.withRunningGateway(async ({ captureSignal, close, loopPromise }) => {
      captureSignal("SIGTERM")();
      await waitForWarning("running agent turn(s)");
      expect(close).not.toHaveBeenCalled();
      // The wait's own listener is the newest SIGTERM listener.
      captureSignal("SIGTERM")();
      await expect(loopPromise).resolves.toBe(0);
      expect(close).toHaveBeenCalledOnce();
      expect(fixture.gatewayLog.warn).toHaveBeenCalledWith(
        "received SIGTERM while waiting; no longer waiting for running agent turns",
      );
    }, true);
  });

  it("closes at once without the variable", async () => {
    work.turns = 1;
    await fixture.withRunningGateway(async ({ captureSignal, close, loopPromise }) => {
      captureSignal("SIGTERM")();
      await expect(loopPromise).resolves.toBe(0);
      expect(close).toHaveBeenCalledOnce();
      expect(fixture.gatewayLog.warn).not.toHaveBeenCalledWith(
        expect.stringContaining("running agent turn(s)"),
      );
    }, true);
  });
});
