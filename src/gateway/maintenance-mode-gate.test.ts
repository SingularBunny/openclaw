import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  enterGatewayMaintenance,
  resetGatewayMaintenanceForTest,
} from "../process/gateway-maintenance-mode.js";
import { gatewayMaintenanceRefusal } from "./maintenance-mode-gate.js";

describe("gateway maintenance gate", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-maint-gate-"));
    resetGatewayMaintenanceForTest(path.join(dir, "gateway-maintenance.json"));
  });
  afterEach(() => {
    resetGatewayMaintenanceForTest();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("lets everything through while maintenance is off", () => {
    expect(gatewayMaintenanceRefusal("chat.send", true)).toBeNull();
  });

  it("refuses new chat turns with a retryable maintenance error", () => {
    enterGatewayMaintenance({ source: "installer", reason: "OpenClaw update" });
    for (const method of ["chat.send", "agent", "sessions.send", "cron.run"]) {
      const error = gatewayMaintenanceRefusal(method, true);
      expect(error).toMatchObject({
        code: "UNAVAILABLE",
        retryable: true,
        details: { reason: "gateway-maintenance", source: "installer", method },
      });
    }
  });

  it("keeps admin work and nested turn requests open", () => {
    enterGatewayMaintenance({ source: "installer" });
    for (const method of ["config.patch", "plugins.install", "chat.history", "chat.abort"]) {
      expect(gatewayMaintenanceRefusal(method, true)).toBeNull();
    }
    expect(gatewayMaintenanceRefusal("agent", false)).toBeNull();
  });
});
