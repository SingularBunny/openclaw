import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "../app/gateway.ts";

export type GatewayStatus =
  | "connecting"
  | "starting"
  | "restarting"
  | "suspending"
  | "suspended"
  | "maintenance"
  | "reconnecting"
  | "restoring"
  | "reload-required"
  | "offline";

export type GatewayStatusSnapshot = Pick<
  ApplicationGatewaySnapshot,
  "phase" | "offlineStable" | "restartPending" | "suspensionPhase" | "maintenance"
> & {
  client: Pick<GatewayBrowserClient, "recoveryScopeReady"> | null;
};

export function resolveGatewayStatus(
  snapshot: GatewayStatusSnapshot,
  refreshRequired = false,
  historyRecovering = false,
): GatewayStatus | null {
  if (refreshRequired || snapshot.phase === "reload-required") {
    return "reload-required";
  }
  if (snapshot.restartPending) {
    return "restarting";
  }
  if (snapshot.suspensionPhase === "preparing" || snapshot.suspensionPhase === "draining") {
    return "suspending";
  }
  if (snapshot.suspensionPhase === "prepared") {
    return "suspended";
  }
  if (snapshot.phase === "connecting" || snapshot.phase === "starting") {
    return snapshot.phase;
  }
  if (snapshot.phase === "connected") {
    if (snapshot.client?.recoveryScopeReady === false || historyRecovering) {
      return "restoring";
    }
    // Fork: maintenance mode pauses chats while the connection itself is fine.
    return snapshot.maintenance ? "maintenance" : null;
  }
  if (snapshot.offlineStable) {
    return snapshot.phase === "reconnecting" ? "reconnecting" : "offline";
  }
  return null;
}
