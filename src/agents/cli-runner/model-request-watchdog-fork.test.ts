import { describe, expect, it, vi } from "vitest";
import { createCliModelRequestWatchdogBridge } from "./model-request-watchdog-fork.js";

const requesting = { type: "system", subtype: "status", status: "requesting" };

function bridge() {
  const requestEvent = vi.fn();
  const watchdog = createCliModelRequestWatchdogBridge({
    attempt: { requestEvent },
    runId: "run-1",
    env: {},
  });
  return { requestEvent, watchdog };
}

describe("Claude CLI request waits reach the session watchdog", () => {
  it("opens a request bounded by the CLI window and closes it on the first response", () => {
    const { requestEvent, watchdog } = bridge();
    watchdog.observe(requesting);
    expect(requestEvent).toHaveBeenLastCalledWith({
      phase: "start",
      callId: "cli-model-request:run-1:1",
      requestTimeoutMs: 210_000,
    });
    watchdog.observe({ type: "stream_event", event: { type: "message_start" } });
    expect(requestEvent).toHaveBeenLastCalledWith({
      phase: "end",
      callId: "cli-model-request:run-1:1",
    });
    expect(requestEvent).toHaveBeenCalledTimes(2);
  });

  it("gives every retry a fresh allowance", () => {
    const { requestEvent, watchdog } = bridge();
    watchdog.observe(requesting);
    watchdog.observe({
      type: "system",
      subtype: "api_retry",
      retry_delay_ms: 2_000,
      no_response: { waited_ms: 180_000, retry_wait_ms: 300_000 },
    });
    expect(requestEvent.mock.calls.map(([event]) => event)).toEqual([
      { phase: "start", callId: "cli-model-request:run-1:1", requestTimeoutMs: 210_000 },
      { phase: "end", callId: "cli-model-request:run-1:1" },
      { phase: "start", callId: "cli-model-request:run-1:2", requestTimeoutMs: 332_000 },
    ]);
    watchdog.close();
    expect(requestEvent).toHaveBeenLastCalledWith({
      phase: "end",
      callId: "cli-model-request:run-1:2",
    });
  });

  it("ignores other output and runs without a watchdog", () => {
    const { requestEvent, watchdog } = bridge();
    watchdog.observe({ type: "system", subtype: "init" });
    watchdog.observe({ type: "assistant", message: { content: [] } });
    expect(requestEvent).not.toHaveBeenCalled();
    const detached = createCliModelRequestWatchdogBridge({ attempt: undefined, runId: "r" });
    expect(() => detached.observe(requesting)).not.toThrow();
  });
});
