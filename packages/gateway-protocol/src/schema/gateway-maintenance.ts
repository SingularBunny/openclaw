// Fork: Gateway maintenance mode, shown by Control UIs as "Maintenance: chats paused".
import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

const EpochMsSchema = Type.Integer({ minimum: 0 });

/** Maintenance is on: new chat turns are refused or queued, admin work stays open. */
export const GatewayMaintenanceSchema = closedObject({
  /** Epoch ms when maintenance began. */
  since: EpochMsSchema,
  /** Who turned it on: `installer`, `control-ui`, `cli`, … */
  source: NonEmptyString,
  /** Free text, e.g. `OpenClaw update`. */
  reason: NonEmptyString,
  /** Epoch ms when it ends on its own; null keeps it until it is turned off. */
  untilMs: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
});

/** `gateway.maintenance` event payload; `maintenance: null` means chats run again. */
export const GatewayMaintenanceEventSchema = closedObject({
  maintenance: Type.Union([GatewayMaintenanceSchema, Type.Null()]),
});

export type GatewayMaintenance = Static<typeof GatewayMaintenanceSchema>;
export type GatewayMaintenanceEvent = Static<typeof GatewayMaintenanceEventSchema>;
