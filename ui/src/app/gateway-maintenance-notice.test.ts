import { describe, expect, it, vi } from "vitest";
import { resolveGatewayStatus } from "../lib/gateway-status.ts";
import type { ApplicationGatewaySnapshot } from "./gateway.ts";
import {
  createGatewayMaintenanceControl,
  isGatewayMaintenanceRefusal,
  readGatewayMaintenance,
  readGatewayMaintenanceEvent,
} from "./gateway-maintenance-notice.ts";

const state = { since: 1_000, source: "installer", reason: "OpenClaw update", untilMs: null };

describe("gateway maintenance (fork)", () => {
  it("reads the snapshot field and the event payload; malformed is off", () => {
    expect(readGatewayMaintenance(state)).toEqual(state);
    expect(readGatewayMaintenanceEvent({ maintenance: state })).toEqual(state);
    expect(readGatewayMaintenanceEvent({ maintenance: null })).toBeNull();
    expect(readGatewayMaintenance({ since: "x" })).toBeNull();
  });

  it("shows Maintenance in the connection indicator only while connected", () => {
    const base = { offlineStable: false, restartPending: false, client: null };
    expect(resolveGatewayStatus({ ...base, phase: "connected", maintenance: state })).toBe(
      "maintenance",
    );
    expect(resolveGatewayStatus({ ...base, phase: "connected", maintenance: null })).toBeNull();
    expect(
      resolveGatewayStatus({ ...base, phase: "connected", restartPending: true, maintenance: state }),
    ).toBe("restarting");
  });

  it("the identity-menu control pauses and resumes chats", () => {
    const request = vi.fn(async () => ({}));
    const client = { request } as unknown as ApplicationGatewaySnapshot["client"];
    const off = createGatewayMaintenanceControl({ client, maintenance: null });
    expect(off?.active).toBe(false);
    off?.toggle();
    expect(request).toHaveBeenLastCalledWith("gateway.maintenance.enter", {
      source: "control-ui",
      reason: "paused from the Control UI",
    });
    const on = createGatewayMaintenanceControl({ client, maintenance: state });
    expect(on?.active).toBe(true);
    on?.toggle();
    expect(request).toHaveBeenLastCalledWith("gateway.maintenance.exit", {});
    expect(createGatewayMaintenanceControl({ client: null, maintenance: null })).toBeNull();
  });

  it("recognizes the maintenance refusal of a chat message", () => {
    expect(isGatewayMaintenanceRefusal({ details: { reason: "gateway-maintenance" } })).toBe(true);
    expect(isGatewayMaintenanceRefusal({ details: { reason: "gateway-suspending" } })).toBe(false);
    expect(isGatewayMaintenanceRefusal(null)).toBe(false);
  });
});
