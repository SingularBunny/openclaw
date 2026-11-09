import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deferGatewayRestartUntilIdle,
  resetGatewayRestartStateForInProcessRestart,
  setPreRestartDeferralCheck,
} from "../infra/restart.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import {
  countActiveAgentWork,
  RESTART_AGENT_RUN_WAIT_ENV,
  resolveRestartAgentRunWait,
} from "./restart-agent-run-wait.js";

const restartSignalHandler = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  restartSignalHandler.mockClear();
  resetGatewayRestartStateForInProcessRestart();
  resetGatewayWorkAdmission();
  setPreRestartDeferralCheck(() => 0);
  process.on("SIGUSR2", restartSignalHandler);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetGatewayRestartStateForInProcessRestart();
  resetGatewayWorkAdmission();
  process.removeListener("SIGUSR2", restartSignalHandler);
});

describe("resolveRestartAgentRunWait", () => {
  it.each([
    [undefined, undefined],
    ["", undefined],
    ["abc", undefined],
    ["-1", undefined],
    ["0", undefined],
    ["300000", undefined],
    ["1.5", undefined],
    ["300001", { maxWaitMs: 300_001 }],
    [" 3600000 ", { maxWaitMs: 3_600_000 }],
    ["unlimited", { maxWaitMs: undefined }],
    ["Unlimited", { maxWaitMs: undefined }],
  ])("%j → %j", (value, expected) => {
    const env = value === undefined ? {} : { [RESTART_AGENT_RUN_WAIT_ENV]: value };
    expect(resolveRestartAgentRunWait(env)).toEqual(expected);
  });

  it("counts the runs a forced restart would abort", () => {
    expect(
      countActiveAgentWork({
        agentRuns: 1,
        embeddedRuns: 2,
        acpRuns: 0,
        chatRuns: 0,
        sessionAdmissions: 1,
      }),
    ).toBe(4);
  });
});

describe("restart deferral with agent-run extension", () => {
  it("keeps waiting past the budget while agent turns run, then restarts without force", async () => {
    let agentRuns = 1;
    const emitRestart = vi.fn((_reason?: string, _intent?: unknown) => ({
      status: "emitted" as const,
    }));
    const onTimeout = vi.fn();
    const onExtended = vi.fn();
    deferGatewayRestartUntilIdle({
      getPendingCount: () => agentRuns,
      maxWaitMs: 100,
      pollMs: 10,
      timeoutIntent: { force: true },
      emitHooks: { emitRestart },
      hooks: { onTimeout },
      extendWhileActive: { isActive: () => agentRuns > 0, onExtended },
    });

    await vi.advanceTimersByTimeAsync(10_000);
    expect(onTimeout).not.toHaveBeenCalled();
    expect(emitRestart).not.toHaveBeenCalled();
    expect(onExtended).toHaveBeenCalledOnce();

    agentRuns = 0;
    await vi.advanceTimersByTimeAsync(20);
    expect(emitRestart).toHaveBeenCalledOnce();
    expect(emitRestart.mock.calls[0]?.[1]).toBeUndefined();
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("forces the restart once agent turns end while other work stays past the budget", async () => {
    let agentRuns = 1;
    const emitRestart = vi.fn((_reason?: string, _intent?: unknown) => ({
      status: "emitted" as const,
    }));
    const onTimeout = vi.fn();
    deferGatewayRestartUntilIdle({
      getPendingCount: () => agentRuns + 1,
      maxWaitMs: 100,
      pollMs: 10,
      timeoutIntent: { force: true },
      emitHooks: { emitRestart },
      hooks: { onTimeout },
      extendWhileActive: { isActive: () => agentRuns > 0 },
    });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(emitRestart).not.toHaveBeenCalled();

    agentRuns = 0;
    await vi.advanceTimersByTimeAsync(20);
    expect(onTimeout).toHaveBeenCalledOnce();
    expect(emitRestart).toHaveBeenCalledOnce();
    expect(emitRestart.mock.calls[0]?.[1]).toMatchObject({ force: true });
  });

  it("forces the restart when the extended bound runs out", async () => {
    const emitRestart = vi.fn((_reason?: string, _intent?: unknown) => ({
      status: "emitted" as const,
    }));
    const onTimeout = vi.fn();
    deferGatewayRestartUntilIdle({
      getPendingCount: () => 1,
      maxWaitMs: 100,
      pollMs: 10,
      timeoutIntent: { force: true },
      emitHooks: { emitRestart },
      hooks: { onTimeout },
      extendWhileActive: { isActive: () => true, maxWaitMs: 500 },
    });

    await vi.advanceTimersByTimeAsync(400);
    expect(onTimeout).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(onTimeout).toHaveBeenCalledOnce();
    expect(emitRestart).toHaveBeenCalledOnce();
    expect(emitRestart.mock.calls[0]?.[1]).toMatchObject({ force: true });
  });

  it("keeps upstream's bound without the extension", async () => {
    const emitRestart = vi.fn(() => ({ status: "emitted" as const }));
    deferGatewayRestartUntilIdle({
      getPendingCount: () => 1,
      maxWaitMs: 100,
      pollMs: 10,
      timeoutIntent: { force: true },
      emitHooks: { emitRestart },
    });
    await vi.advanceTimersByTimeAsync(110);
    expect(emitRestart).toHaveBeenCalledOnce();
  });
});
