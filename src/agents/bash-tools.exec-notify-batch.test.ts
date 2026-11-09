import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionEventTarget } from "../auto-reply/reply/session-event-contract.js";
import {
  deliverExecExitNotice,
  type ExecExitNotice,
  setExecExitNoticeBatchDepsForTest,
} from "./bash-tools.exec-notify-batch.js";

const target: SessionEventTarget = { sessionId: "s1", generation: "g1" };

function notice(id: string, extra: Partial<ExecExitNotice> = {}): ExecExitNotice {
  return {
    id,
    instanceId: `inst-${id}`,
    text: `Exec completed (${id}, code 0) :: out ${id}`,
    agentId: "work",
    sessionKey: "agent:work:chat",
    target,
    isObsolete: () => false,
    ...extra,
  };
}

function harness(initiallyBusy: boolean) {
  let busy = initiallyBusy;
  let release: (() => void) | undefined;
  const enqueue = vi.fn((_text: string, _options: Record<string, unknown>) => ({
    id: "receipt",
    cancel: vi.fn(() => true),
    accepted: Promise.resolve({ ok: true as const }),
    settled: Promise.resolve({
      status: "completed" as const,
      executionStarted: true,
      delivered: true,
    }),
  }));
  setExecExitNoticeBatchDepsForTest({
    isSessionBusy: () => busy,
    waitForIdle: () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    enqueue: enqueue as never,
  });
  return {
    enqueue,
    async finishTurn() {
      await vi.waitFor(() => expect(release).toBeDefined());
      busy = false;
      release?.();
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
    },
  };
}

afterEach(() => setExecExitNoticeBatchDepsForTest());

describe("exec completion batching (fork)", () => {
  it("delivers a completion at once when its session is idle", () => {
    const { enqueue } = harness(false);
    deliverExecExitNotice(notice("calm-wil"));
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0]?.[0]).toBe("Exec completed (calm-wil, code 0) :: out calm-wil");
    expect(enqueue.mock.calls[0]?.[1]).toMatchObject({
      source: "exec",
      contextKey: "exec:calm-wil",
      expectedTarget: target,
    });
  });

  it("holds completions during a running turn and sends them as one event after it", async () => {
    const h = harness(true);
    deliverExecExitNotice(notice("calm-wil"));
    deliverExecExitNotice(notice("brisk-ca"));
    deliverExecExitNotice(notice("nova-zep"));
    expect(h.enqueue).not.toHaveBeenCalled();
    await h.finishTurn();
    expect(h.enqueue).toHaveBeenCalledTimes(1);
    expect(h.enqueue.mock.calls[0]?.[0]).toBe(
      [
        "Exec completed (calm-wil, code 0) :: out calm-wil",
        "Exec completed (brisk-ca, code 0) :: out brisk-ca",
        "Exec completed (nova-zep, code 0) :: out nova-zep",
      ].join("\n"),
    );
    expect(h.enqueue.mock.calls[0]?.[1]).toMatchObject({
      contextKey: "exec:calm-wil,brisk-ca,nova-zep",
      sourceTurnId: "exec:inst-calm-wil,inst-brisk-ca,inst-nova-zep",
    });
  });

  it("drops held completions the agent already read or that were removed", async () => {
    const h = harness(true);
    deliverExecExitNotice(notice("polled", { isObsolete: () => true }));
    const remove = deliverExecExitNotice(notice("removed"));
    deliverExecExitNotice(notice("kept"));
    expect(remove()).toBe(true);
    await h.finishTurn();
    expect(h.enqueue).toHaveBeenCalledTimes(1);
    expect(h.enqueue.mock.calls[0]?.[0]).toBe("Exec completed (kept, code 0) :: out kept");
  });

  it("sends nothing when every held completion became obsolete", async () => {
    const h = harness(true);
    deliverExecExitNotice(notice("polled", { isObsolete: () => true }));
    await h.finishTurn();
    expect(h.enqueue).not.toHaveBeenCalled();
  });
});
