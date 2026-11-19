// Fork (F36 on 2026.11.5): the session watchdog of 2026.11.5 aborts a turn after six minutes
// without model progress. Claude CLI is silent on stdout while an API request waits for its
// first byte, and retries a dropped or unanswered request on its own (`api_retry`). Each such
// wait is published to the watchdog as a model request bounded by the CLI's own window, so a
// network hiccup is waited out like the CLI does, while real silence still ends the turn.
import { createCliModelRequestWait } from "./native-wait-state.js";

type WatchdogRequests = {
  requestEvent(event: { phase: "start" | "end"; callId: string; requestTimeoutMs?: number }): void;
};

function restartsWait(record: Record<string, unknown>): boolean {
  return (
    record.type === "system" &&
    (record.subtype === "api_retry" ||
      (record.subtype === "status" && record.status === "requesting"))
  );
}

export function createCliModelRequestWatchdogBridge(params: {
  attempt: WatchdogRequests | undefined;
  runId: string;
  env?: Readonly<Record<string, string | undefined>>;
}) {
  const attempt = params.attempt;
  const wait = createCliModelRequestWait({ env: params.env });
  let sequence = 0;
  let open: string | undefined;
  const end = () => {
    if (open) {
      attempt?.requestEvent({ phase: "end", callId: open });
      open = undefined;
    }
  };
  const observe = (record: Record<string, unknown>) => {
    wait.observe(record);
    const graceMs = wait.graceMs();
    if (graceMs === undefined) {
      end();
      return;
    }
    if (open && !restartsWait(record)) {
      return;
    }
    // Every request and retry restarts the CLI's own window, so it gets a fresh allowance.
    end();
    sequence += 1;
    open = `cli-model-request:${params.runId}:${sequence}`;
    attempt?.requestEvent({ phase: "start", callId: open, requestTimeoutMs: graceMs });
  };
  return {
    /** Every stream record of the turn, in order. */
    observe(record: Record<string, unknown>) {
      if (attempt) {
        observe(record);
      }
    },
    close: end,
  };
}
