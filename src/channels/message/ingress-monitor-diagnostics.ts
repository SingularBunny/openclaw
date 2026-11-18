import { randomUUID } from "node:crypto";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  getGatewayRestartDrainSignal,
  getGatewaySuspendAdmissionPhase,
  isGatewayRestartDraining,
} from "../../process/gateway-work-admission.js";

type IngressMonitorDiagnosticState = {
  running: boolean;
  stopped: boolean;
  aborted: boolean;
  requested: boolean;
  pumping: boolean;
  inspections: number;
  deliveries: number;
};

/**
 * Bounded debug observations of one ingress monitor; never record queue keys, payloads, or
 * errors. `readState` is read only when an observation is written.
 */
export function createIngressDiagnostics(readState: () => IngressMonitorDiagnosticState) {
  const diagnosticId = randomUUID();
  const diagnosticLog = createSubsystemLogger("channels/ingress");
  let diagnosticCount = 0;
  return (phase: string, facts: Record<string, string | number | boolean> = {}) => {
    if (diagnosticCount >= 96) {
      return;
    }
    try {
      if (!diagnosticLog.isEnabled("debug")) {
        return;
      }
      diagnosticCount += 1;
      const state = readState();
      diagnosticLog.debug(
        "ingress monitor " +
          JSON.stringify({
            monitor: diagnosticId,
            sequence: diagnosticCount,
            phase,
            running: state.running,
            stopped: state.stopped,
            aborted: state.aborted,
            restartAborted: getGatewayRestartDrainSignal().aborted,
            restarting: isGatewayRestartDraining(),
            suspend: getGatewaySuspendAdmissionPhase(),
            requested: state.requested,
            pumping: state.pumping,
            inspections: state.inspections,
            deliveries: state.deliveries,
            ...facts,
            exhausted: diagnosticCount === 96,
          }),
      );
    } catch {
      // Observations cannot change admission or delivery.
    }
  };
}
