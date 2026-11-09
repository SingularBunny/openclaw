// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAvatarGatewayOrigin } from "../lib/identity-avatar-context.ts";
import {
  createGatewayEvent,
  createGatewayStoreTestStore as createStore,
  GATEWAY_STORE_TEST_HELLO as HELLO,
  stubGatewayStoreTestGlobals,
} from "./gateway-store.test-support.ts";

const notice = {
  phase: "pending",
  reason: "config reload: env.vars.OPENCLAW_X",
  since: 1_000,
  deadlineAt: 1_801_000,
  activeTurns: 2,
  activeWork: 3,
} as const;

// Fork: restart-pending notice outside the chat (gateway.restart, hello snapshot.gatewayRestart).
describe("gateway store restart notice", () => {
  let gateway: ReturnType<typeof createStore>["gateway"];
  let current: ReturnType<typeof createStore>["current"];
  beforeEach(() => {
    stubGatewayStoreTestGlobals();
    ({ gateway, current } = createStore());
  });
  afterEach(async () => {
    gateway.stop();
    await vi.dynamicImportSettled();
    setAvatarGatewayOrigin(null);
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("follows gateway.restart events and ignores malformed ones", () => {
    gateway.start();
    current().opts.onHello?.(HELLO);
    expect(gateway.snapshot.restartNotice).toBeNull();
    current().opts.onEvent?.(createGatewayEvent("gateway.restart", { notice }));
    expect(gateway.snapshot.restartNotice).toEqual(notice);
    current().opts.onEvent?.(
      createGatewayEvent("gateway.restart", { notice: { ...notice, activeTurns: -1 } }),
    );
    expect(gateway.snapshot.restartNotice).toBeNull();
    current().opts.onEvent?.(createGatewayEvent("gateway.restart", { notice }));
    current().opts.onEvent?.(createGatewayEvent("gateway.restart", { notice: null }));
    expect(gateway.snapshot.restartNotice).toBeNull();
  });

  it("reads a pending restart from hello, and marks the reconnect after a restart", () => {
    gateway.start();
    current().opts.onHello?.({
      ...HELLO,
      snapshot: { gatewayRestart: notice },
    } as typeof HELLO);
    expect(gateway.snapshot.restartNotice).toEqual(notice);
    expect(gateway.snapshot.restartedAt).toBeUndefined();

    current().opts.onEvent?.(
      createGatewayEvent("gateway.restart", { notice: { ...notice, phase: "restarting" } }),
    );
    // The closing Gateway clears its notice before the socket goes.
    current().opts.onEvent?.(createGatewayEvent("gateway.restart", { notice: null }));
    current().opts.onClose?.({ code: 1012, reason: "gateway restarting", willRetry: true });
    current().opts.onHello?.(HELLO);
    expect(gateway.snapshot.restartNotice).toBeNull();
    expect(typeof gateway.snapshot.restartedAt).toBe("number");

    // An ordinary reconnect does not claim a restart.
    const first = gateway.snapshot.restartedAt;
    current().opts.onClose?.({ code: 1006, reason: "network", willRetry: true });
    current().opts.onHello?.(HELLO);
    expect(gateway.snapshot.restartedAt).toBe(first);
  });

  it("a restart-bearing shutdown also counts as a restart", () => {
    gateway.start();
    current().opts.onHello?.(HELLO);
    current().opts.onEvent?.(
      createGatewayEvent("shutdown", { reason: "gateway restart", restartExpectedMs: 8_000 }),
    );
    current().opts.onClose?.({ code: 1012, reason: "gateway restarting", willRetry: true });
    current().opts.onHello?.(HELLO);
    expect(typeof gateway.snapshot.restartedAt).toBe("number");
  });
});
