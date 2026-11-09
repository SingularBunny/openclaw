import { describe, expect, it } from "vitest";
import {
  GATEWAY_RESTARTED_NOTICE_MS,
  readGatewayRestartNotice,
  resolveGatewayRestartBanner,
} from "./gateway-restart-notice.ts";

const translate = (key: string, params?: Record<string, string>) =>
  `${key}${params ? JSON.stringify(params) : ""}`;

const pending = {
  phase: "pending",
  reason: "config reload: env.vars.OPENCLAW_X",
  since: 0,
  deadlineAt: 28 * 60_000 - 1,
  activeTurns: 2,
  activeWork: 3,
} as const;

describe("gateway restart notice", () => {
  it("reads only well-formed notices", () => {
    expect(readGatewayRestartNotice(pending)).toEqual(pending);
    expect(readGatewayRestartNotice({ ...pending, deadlineAt: null })?.deadlineAt).toBeNull();
    for (const bad of [null, "x", { ...pending, phase: "done" }, { ...pending, reason: " " }]) {
      expect(readGatewayRestartNotice(bad)).toBeNull();
    }
    expect(readGatewayRestartNotice({ ...pending, activeWork: 1.5 })).toBeNull();
  });

  it("says what a pending restart waits for, when it happens at the latest and why", () => {
    const banner = resolveGatewayRestartBanner(
      { phase: "connected", restartNotice: pending },
      0,
      translate,
    );
    expect(banner?.kind).toBe("pending");
    expect(banner?.text).toContain('"reason":"env.vars.OPENCLAW_X"');
    expect(banner?.text).toContain('common.gatewayRestart.waitingTurns{\\"count\\":\\"2\\"}');
    expect(banner?.text).toContain('common.gatewayRestart.atMostIn{\\"minutes\\":\\"28\\"}');

    const one = resolveGatewayRestartBanner(
      { phase: "connected", restartNotice: { ...pending, activeTurns: 1, deadlineAt: null } },
      0,
      translate,
    );
    expect(one?.text).toContain("common.gatewayRestart.waitingTurn{");
    expect(one?.text).toContain("common.gatewayRestart.whenTurnsFinish");

    const work = resolveGatewayRestartBanner(
      { phase: "connected", restartNotice: { ...pending, activeTurns: 0, activeWork: 4 } },
      0,
      translate,
    );
    expect(work?.text).toContain('common.gatewayRestart.waitingWork{\\"count\\":\\"4\\"}');
  });

  it("shows restarting now, then restarted briefly after the reconnect", () => {
    expect(
      resolveGatewayRestartBanner({ phase: "reconnecting", restartPending: true }, 0, translate)
        ?.kind,
    ).toBe("restarting");
    expect(
      resolveGatewayRestartBanner(
        { phase: "connected", restartNotice: { ...pending, phase: "restarting" } },
        0,
        translate,
      )?.text,
    ).toBe("common.gatewayRestart.restarting");
    const restarted = { phase: "connected", restartedAt: 1_000 } as const;
    expect(resolveGatewayRestartBanner(restarted, 1_000, translate)?.kind).toBe("restarted");
    expect(
      resolveGatewayRestartBanner(restarted, 1_000 + GATEWAY_RESTARTED_NOTICE_MS, translate),
    ).toBeNull();
    // A pending notice from a Gateway the page is not connected to is not shown.
    expect(
      resolveGatewayRestartBanner({ phase: "reconnecting", restartNotice: pending }, 0, translate),
    ).toBeNull();
  });
});
