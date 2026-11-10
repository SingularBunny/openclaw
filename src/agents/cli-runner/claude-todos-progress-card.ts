import type { ProgressCardStep } from "../../../packages/gateway-protocol/src/schema/progress-card.js";
import { cliBackendLog } from "./log.js";

const PROGRESS_CARD_WRITE_TIMEOUT_MS = 10_000;

type ProgressCardCaller = (
  method: string,
  opts: { timeoutMs?: number },
  params: Record<string, unknown>,
) => Promise<unknown>;

/**
 * Fork (F45): saves Claude's todo list as the session progress card, the same durable
 * card `progress_card`/`update_plan` writes, so Details → Task progress, hovercards and
 * channel progress all show it. Writes are serialized and coalesced: while one is in
 * flight only the latest list waits. An empty list clears the card. Failures are logged
 * once per run; the card is presentation and never fails the turn.
 */
export function createClaudeTodoProgressCardWriter(params: {
  sessionKey: string;
  agentId?: string;
  call?: ProgressCardCaller;
}) {
  const call: ProgressCardCaller =
    params.call ??
    // Loaded on first use: the Gateway client graph stays out of runs without a todo list.
    (async (method, opts, body) => {
      const { callGatewayTool } = await import("../tools/gateway.js");
      return await callGatewayTool(method, opts, body);
    });
  let inFlight: Promise<void> | undefined;
  let queued: ProgressCardStep[] | undefined;
  let warned = false;
  const writeOnce = async (steps: ProgressCardStep[]) => {
    try {
      await call(
        "progressCard.put",
        { timeoutMs: PROGRESS_CARD_WRITE_TIMEOUT_MS },
        {
          sessionKey: params.sessionKey,
          ...(params.agentId ? { agentId: params.agentId } : {}),
          ...(steps.length > 0 ? { plan: steps } : {}),
        },
      );
    } catch (error) {
      if (!warned) {
        warned = true;
        cliBackendLog.warn(`claude todo list was not saved as the progress card: ${String(error)}`);
      }
    }
  };
  const drain = async () => {
    while (queued) {
      const next = queued;
      queued = undefined;
      await writeOnce(next);
    }
    inFlight = undefined;
  };
  return {
    write(steps: ProgressCardStep[]) {
      queued = steps;
      inFlight ??= drain();
    },
    /** Resolves once every accepted list has been written (tests and shutdown). */
    idle: async () => {
      await inFlight;
    },
  };
}
