import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { GatewayMaintenance } from "../../../packages/gateway-protocol/src/index.js";
import { registerGatewayMaintenanceEnglish } from "../i18n/locales/en-gateway-maintenance.ts";
import type { GatewayMaintenanceControl } from "../lib/gateway-maintenance-control.ts";
import type { ApplicationGatewaySnapshot } from "./gateway.ts";
export { isGatewayMaintenanceRefusal } from "../lib/gateway-maintenance-control.ts";

registerGatewayMaintenanceEnglish();

type Translate = (key: string, params?: Record<string, string>) => string;

/** Fork: reads `gateway.maintenance` / `snapshot.gatewayMaintenance`; anything malformed is "off". */
export function readGatewayMaintenance(value: unknown): GatewayMaintenance | null {
  const record = asOptionalRecord(value);
  if (
    !record ||
    typeof record.since !== "number" ||
    !Number.isFinite(record.since) ||
    typeof record.source !== "string" ||
    typeof record.reason !== "string"
  ) {
    return null;
  }
  const until = record.untilMs;
  return {
    since: record.since,
    source: record.source,
    reason: record.reason,
    untilMs: typeof until === "number" && Number.isFinite(until) ? until : null,
  };
}

/** The `gateway.maintenance` event payload: `{ maintenance: … | null }`. */
export function readGatewayMaintenanceEvent(payload: unknown): GatewayMaintenance | null {
  return readGatewayMaintenance(asOptionalRecord(payload)?.maintenance);
}

export type GatewayMaintenanceBanner = { text: string; hint: string | null };

/** The banner while maintenance is on and this page is connected; null otherwise. */
export function resolveGatewayMaintenanceBanner(
  snapshot: Pick<ApplicationGatewaySnapshot, "phase" | "maintenance">,
  translate: Translate,
  formatTime: (ms: number) => string = (ms) =>
    new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
): GatewayMaintenanceBanner | null {
  const maintenance = snapshot.maintenance;
  if (!maintenance || snapshot.phase !== "connected") {
    return null;
  }
  const params = {
    reason: maintenance.reason,
    since: formatTime(maintenance.since),
    source: maintenance.source,
  };
  const byPerson = maintenance.source === "control-ui";
  return {
    text: translate(
      byPerson ? "common.gatewayMaintenance.banner" : "common.gatewayMaintenance.bannerBy",
      params,
    ),
    hint:
      maintenance.source === "installer"
        ? translate("common.gatewayMaintenance.installerHint")
        : null,
  };
}

/**
 * The identity-menu control (Pause chats / Resume chats) for an admin on a connected Gateway;
 * the banner and status follow the `gateway.maintenance` event, not this request's reply.
 */
export function createGatewayMaintenanceControl(
  snapshot: Pick<ApplicationGatewaySnapshot, "client" | "maintenance">,
  onError: (message: string) => void = (message) => console.warn(message),
): GatewayMaintenanceControl | null {
  const client = snapshot.client;
  if (!client) {
    return null;
  }
  const active = Boolean(snapshot.maintenance);
  return {
    active,
    toggle: () => {
      const request = active
        ? client.request("gateway.maintenance.exit", {})
        : client.request("gateway.maintenance.enter", {
            source: "control-ui",
            reason: "paused from the Control UI",
          });
      void request.catch((err: unknown) =>
        onError(`maintenance mode: ${err instanceof Error ? err.message : String(err)}`),
      );
    },
  };
}
