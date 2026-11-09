import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { GatewayRestartNotice } from "../../../packages/gateway-protocol/src/index.js";
import { registerGatewayRestartEnglish } from "../i18n/locales/en-gateway-restart.ts";
import type { ApplicationGatewaySnapshot } from "./gateway.ts";

registerGatewayRestartEnglish();

/** How long "Gateway restarted" stays after the reconnect. */
export const GATEWAY_RESTARTED_NOTICE_MS = 10_000;

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

/** Fork: reads `gateway.restart` / `snapshot.gatewayRestart`; anything malformed is no notice. */
export function readGatewayRestartNotice(value: unknown): GatewayRestartNotice | null {
  const record = asOptionalRecord(value);
  if (
    !record ||
    (record.phase !== "pending" && record.phase !== "restarting") ||
    typeof record.reason !== "string" ||
    !record.reason.trim() ||
    !isCount(record.since) ||
    !(record.deadlineAt === null || isCount(record.deadlineAt)) ||
    !isCount(record.activeTurns) ||
    !isCount(record.activeWork)
  ) {
    return null;
  }
  return {
    phase: record.phase,
    reason: record.reason,
    since: record.since,
    deadlineAt: record.deadlineAt,
    activeTurns: record.activeTurns,
    activeWork: record.activeWork,
  };
}

export type GatewayRestartBanner = {
  kind: "pending" | "restarting" | "restarted";
  tone: "warn" | "info";
  text: string;
};

type Translate = (key: string, params?: Record<string, string>) => string;

/** A config path list reads better without the internal prefix. */
function displayReason(reason: string): string {
  return reason.replace(/^config reload:\s*/u, "").trim() || reason;
}

/**
 * The app-level restart notice: pending (with what it waits for and the latest restart time),
 * restarting now, or restarted (briefly, after the reconnect). Null when there is nothing to say.
 */
export function resolveGatewayRestartBanner(
  snapshot: Pick<
    ApplicationGatewaySnapshot,
    "phase" | "restartPending" | "restartNotice" | "restartedAt"
  >,
  now: number,
  translate: Translate,
): GatewayRestartBanner | null {
  const notice = snapshot.restartNotice ?? null;
  if (snapshot.restartPending || notice?.phase === "restarting") {
    return {
      kind: "restarting",
      tone: "warn",
      text: translate("common.gatewayRestart.restarting"),
    };
  }
  if (notice?.phase === "pending" && snapshot.phase === "connected") {
    const waiting =
      notice.activeTurns > 0
        ? translate(
            notice.activeTurns === 1
              ? "common.gatewayRestart.waitingTurn"
              : "common.gatewayRestart.waitingTurns",
            { count: String(notice.activeTurns) },
          )
        : notice.activeWork > 0
          ? translate("common.gatewayRestart.waitingWork", { count: String(notice.activeWork) })
          : translate("common.gatewayRestart.waitingNothing");
    const when =
      notice.deadlineAt === null
        ? translate("common.gatewayRestart.whenTurnsFinish")
        : translate("common.gatewayRestart.atMostIn", {
            minutes: String(Math.max(1, Math.ceil((notice.deadlineAt - now) / 60_000))),
          });
    return {
      kind: "pending",
      tone: "warn",
      text: translate("common.gatewayRestart.pending", {
        waiting,
        when,
        reason: displayReason(notice.reason),
      }),
    };
  }
  if (
    snapshot.phase === "connected" &&
    typeof snapshot.restartedAt === "number" &&
    now - snapshot.restartedAt < GATEWAY_RESTARTED_NOTICE_MS
  ) {
    return { kind: "restarted", tone: "info", text: translate("common.gatewayRestart.restarted") };
  }
  return null;
}
