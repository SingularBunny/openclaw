import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  enterGatewayMaintenance,
  exitGatewayMaintenance,
  formatGatewayMaintenanceMessage,
  getGatewayMaintenance,
  isGatewayMaintenanceActive,
  normalizeGatewayMaintenanceState,
  onGatewayMaintenanceChange,
  resetGatewayMaintenanceForTest,
} from "./gateway-maintenance-mode.js";

describe("gateway maintenance mode", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-maint-"));
    file = path.join(dir, "gateway-maintenance.json");
    resetGatewayMaintenanceForTest(file);
  });
  afterEach(() => {
    resetGatewayMaintenanceForTest();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("is off without a state file", () => {
    expect(getGatewayMaintenance()).toBeNull();
    expect(isGatewayMaintenanceActive()).toBe(false);
  });

  it("persists across a restart and notifies listeners", () => {
    const seen: unknown[] = [];
    onGatewayMaintenanceChange((state) => seen.push(state));
    const state = enterGatewayMaintenance({ source: "installer", reason: "OpenClaw update" });
    expect(seen).toEqual([state]);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toMatchObject({ source: "installer" });

    // A new Gateway process reads the same file.
    resetGatewayMaintenanceForTest(file);
    expect(getGatewayMaintenance()).toEqual(state);

    expect(exitGatewayMaintenance()).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
    expect(exitGatewayMaintenance()).toBe(false);
  });

  it("keeps the original start time when entered again", () => {
    const first = enterGatewayMaintenance({ source: "installer", now: 1_000 });
    const second = enterGatewayMaintenance({ source: "control-ui", now: 5_000 });
    expect(second.since).toBe(first.since);
    expect(second.source).toBe("control-ui");
  });

  it("ends on its own after ttlMs", () => {
    const now = Date.now();
    enterGatewayMaintenance({ source: "installer", ttlMs: 60_000, now: now - 120_000 });
    const seen: unknown[] = [];
    onGatewayMaintenanceChange((state) => seen.push(state));
    expect(getGatewayMaintenance(now)).toBeNull();
    expect(seen).toEqual([null]);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("reads a malformed file as off", () => {
    fs.writeFileSync(file, "{not json");
    expect(getGatewayMaintenance()).toBeNull();
    expect(normalizeGatewayMaintenanceState({ since: -1 })).toBeNull();
  });

  it("explains the pause to a channel sender", () => {
    const text = formatGatewayMaintenanceMessage(
      enterGatewayMaintenance({ source: "installer", reason: "OpenClaw update" }),
    );
    expect(text).toContain("under maintenance (OpenClaw update)");
    expect(text).toContain("send it again");
  });
});
