import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { GatewayEventListener, GatewayHelloOk } from "../api/gateway.ts";
import {
  readGatewayMaintenance,
  readGatewayMaintenanceEvent,
} from "./gateway-maintenance-notice.ts";
import { readGatewayRestartNotice } from "./gateway-restart-notice.ts";
import type { ApplicationGatewaySnapshot } from "./gateway.ts";

type SnapshotPatch = Partial<ApplicationGatewaySnapshot>;

/**
 * Fork: maintenance mode (app-shell-maintenance-notice.tsx) and the restart-pending notice,
 * shown outside the chat (gateway-restart-notice.ts). Remembers a restart this page was told
 * about (shutdown with restart, restarting notice) so the reconnect shows "Gateway restarted".
 */
export function createGatewayForkNotices() {
  let restartAwaited = false;
  return {
    applyEvent(
      event: Parameters<GatewayEventListener>[0],
      setSnapshot: (patch: SnapshotPatch) => void,
    ) {
      if (event.event === "gateway.maintenance") {
        setSnapshot({ maintenance: readGatewayMaintenanceEvent(event.payload) });
      } else if (event.event === "gateway.restart") {
        const restartNotice = readGatewayRestartNotice(asOptionalRecord(event.payload)?.notice);
        restartAwaited ||=
          restartNotice?.phase === "restarting" || restartNotice?.phase === "draining";
        setSnapshot({ restartNotice });
      } else if (
        event.event === "shutdown" &&
        typeof asOptionalRecord(event.payload)?.restartExpectedMs === "number"
      ) {
        restartAwaited = true;
      }
    },
    /** Fields of the connected snapshot; consumes the awaited restart. */
    connected(hello: GatewayHelloOk): SnapshotPatch {
      const restarted = restartAwaited;
      restartAwaited = false;
      return {
        restartNotice: readGatewayRestartNotice(asOptionalRecord(hello.snapshot)?.gatewayRestart),
        maintenance: readGatewayMaintenance(asOptionalRecord(hello.snapshot)?.gatewayMaintenance),
        ...(restarted ? { restartedAt: Date.now() } : {}),
      };
    },
  };
}
