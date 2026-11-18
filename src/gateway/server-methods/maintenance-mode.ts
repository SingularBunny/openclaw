import { Type } from "typebox";
import { Value } from "typebox/value";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { createGatewayActiveWorkSnapshot } from "../../infra/gateway-active-work.js";
import {
  enterGatewayMaintenance,
  exitGatewayMaintenance,
  getGatewayMaintenance,
} from "../../process/gateway-maintenance-mode.js";
import { countRunningAgentTurns } from "../restart-agent-run-wait.js";
import { createGatewayServerActiveWorkInspectors } from "../server-active-work.js";
import type { GatewayRequestHandlers } from "./types.js";

/**
 * Fork: maintenance mode RPCs. `gateway.maintenance.enter` pauses new chat turns (admin work
 * stays open) and persists across a Gateway restart; `status` reports how many turns still run,
 * so a caller can wait for them before replacing OpenClaw; `exit` resumes chats.
 */
const EnterParamsSchema = Type.Object(
  {
    source: Type.Optional(Type.String({ maxLength: 64 })),
    reason: Type.Optional(Type.String({ maxLength: 200 })),
    /** Ends maintenance on its own after this many ms (at most 24 h); omitted keeps it on. */
    ttlMs: Type.Optional(Type.Integer({ minimum: 1_000, maximum: 86_400_000 })),
  },
  { additionalProperties: false },
);
const EmptyParamsSchema = Type.Object({}, { additionalProperties: false });

export type GatewayMaintenanceStatus = {
  active: boolean;
  maintenance: ReturnType<typeof getGatewayMaintenance>;
  /** Agent turns (chat, cron, ACP) still running. */
  activeTurns: number;
  /** Turns plus queued turns and reply deliveries that finish them. */
  activeWork: number;
  blockers: string[];
};

export function readGatewayMaintenanceStatus(
  context: Parameters<typeof createGatewayServerActiveWorkInspectors>[0],
): GatewayMaintenanceStatus {
  const maintenance = getGatewayMaintenance();
  const snapshot = createGatewayActiveWorkSnapshot(
    createGatewayServerActiveWorkInspectors(context),
  );
  const { counts } = snapshot;
  const activeTurns = countRunningAgentTurns(counts) + counts.cronRuns + counts.mediaRuns;
  const activeWork = activeTurns + counts.queuedTurns + counts.pendingReplies;
  const turnKinds = new Set([
    "embedded-run",
    "agent-run",
    "acp-run",
    "chat-run",
    "queued-turn",
    "cron-run",
    "media-generation",
    "reply",
  ]);
  return {
    active: maintenance !== null,
    maintenance,
    activeTurns,
    activeWork,
    blockers: snapshot.blockers
      .filter((blocker) => turnKinds.has(blocker.kind))
      .map((blocker) => blocker.message)
      .slice(0, 8),
  };
}

function invalid(method: string, shape: string) {
  return errorShape(ErrorCodes.INVALID_REQUEST, `${method} expects ${shape}`);
}

export const maintenanceModeHandlers: GatewayRequestHandlers = {
  "gateway.maintenance.status": ({ params, respond, context }) => {
    if (params !== undefined && params !== null && !Value.Check(EmptyParamsSchema, params)) {
      respond(false, undefined, invalid("gateway.maintenance.status", "{}"));
      return;
    }
    respond(true, readGatewayMaintenanceStatus(context));
  },
  "gateway.maintenance.enter": ({ params, respond, context }) => {
    const input = params ?? {};
    if (!Value.Check(EnterParamsSchema, input)) {
      respond(
        false,
        undefined,
        invalid("gateway.maintenance.enter", "{ source?, reason?, ttlMs? }"),
      );
      return;
    }
    try {
      const state = enterGatewayMaintenance({
        source: input.source ?? "rpc",
        reason: input.reason,
        ttlMs: input.ttlMs ?? null,
      });
      context.logGateway.info(
        `maintenance mode on: source=${state.source} reason=${state.reason}${state.untilMs ? ` until=${new Date(state.untilMs).toISOString()}` : ""}`,
      );
    } catch (error) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, `maintenance state not saved: ${String(error)}`),
      );
      return;
    }
    respond(true, readGatewayMaintenanceStatus(context));
  },
  "gateway.maintenance.exit": ({ params, respond, context }) => {
    if (params !== undefined && params !== null && !Value.Check(EmptyParamsSchema, params)) {
      respond(false, undefined, invalid("gateway.maintenance.exit", "{}"));
      return;
    }
    let wasActive: boolean;
    try {
      wasActive = exitGatewayMaintenance();
    } catch (error) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, `maintenance state not cleared: ${String(error)}`),
      );
      return;
    }
    if (wasActive) {
      context.logGateway.info("maintenance mode off: chats resume");
    }
    respond(true, { ...readGatewayMaintenanceStatus(context), resumed: wasActive });
  },
};
