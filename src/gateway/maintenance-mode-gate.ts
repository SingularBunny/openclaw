// Fork: which Gateway requests maintenance mode refuses (src/process/gateway-maintenance-mode.ts).
import { ErrorCodes, errorShape } from "../../packages/gateway-protocol/src/index.js";
import {
  GATEWAY_MAINTENANCE_UNAVAILABLE_REASON,
  getGatewayMaintenance,
  type GatewayMaintenanceState,
} from "../process/gateway-maintenance-mode.js";

/**
 * Requests that start a new chat turn. Everything else (config, plugins, skills, cron edits,
 * history reads, aborts, approvals) stays available while chats are paused.
 */
export const GATEWAY_MAINTENANCE_PAUSED_METHODS: ReadonlySet<string> = new Set([
  "chat.send",
  "sessions.send",
  "sessions.steer",
  "agent",
  "openclaw.chat",
  "cron.run",
  "talk.client.create",
  "talk.session.create",
]);

/** Clients retry a refused message on this cadence; the Control UI keeps it in its outbox. */
export const GATEWAY_MAINTENANCE_RETRY_AFTER_MS = 15_000;

export function gatewayMaintenanceUnavailableError(
  method: string,
  state: GatewayMaintenanceState,
) {
  return errorShape(
    ErrorCodes.UNAVAILABLE,
    `${method} paused: OpenClaw is under maintenance (${state.reason}); retry when it ends`,
    {
      retryable: true,
      retryAfterMs: GATEWAY_MAINTENANCE_RETRY_AFTER_MS,
      details: {
        method,
        reason: GATEWAY_MAINTENANCE_UNAVAILABLE_REASON,
        since: state.since,
        source: state.source,
        maintenanceReason: state.reason,
        untilMs: state.untilMs,
      },
    },
  );
}

/**
 * The refusal for a new root request while maintenance is on, or null. Requests nested in an
 * admitted turn (a subagent of a turn that started before maintenance) pass so it can finish.
 */
export function gatewayMaintenanceRefusal(method: string, ownsRoot: boolean) {
  if (!ownsRoot || !GATEWAY_MAINTENANCE_PAUSED_METHODS.has(method)) {
    return null;
  }
  const state = getGatewayMaintenance();
  return state ? gatewayMaintenanceUnavailableError(method, state) : null;
}
