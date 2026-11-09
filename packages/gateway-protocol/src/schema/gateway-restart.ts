// Fork: a Gateway restart that waits for running work, shown by Control UIs outside the chat.
import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

const CountSchema = Type.Integer({ minimum: 0 });

/**
 * `pending`: a restart is deferred until running work finishes; `restarting`: the wait is over
 * and the Gateway restarts now.
 */
export const GatewayRestartNoticeSchema = closedObject({
  phase: Type.Union([Type.Literal("pending"), Type.Literal("restarting")]),
  /** What asked for the restart, e.g. `config reload: env.vars.X`. */
  reason: NonEmptyString,
  /** Epoch ms when the wait began. */
  since: CountSchema,
  /** Epoch ms by which the restart happens at the latest; null waits until agent turns finish. */
  deadlineAt: Type.Union([CountSchema, Type.Null()]),
  /** Running agent turns the restart waits for. */
  activeTurns: CountSchema,
  /** All work the restart waits for, agent turns included. */
  activeWork: CountSchema,
});

/** `gateway.restart` event payload; `notice: null` clears it. */
export const GatewayRestartEventSchema = closedObject({
  notice: Type.Union([GatewayRestartNoticeSchema, Type.Null()]),
});

export type GatewayRestartNotice = Static<typeof GatewayRestartNoticeSchema>;
export type GatewayRestartEvent = Static<typeof GatewayRestartEventSchema>;
