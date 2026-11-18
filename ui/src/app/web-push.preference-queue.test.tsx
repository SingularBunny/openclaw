// Fork: queued notification preference saves (web-push.ts) rebase onto each other.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebPushNotificationPreferences } from "../../../packages/gateway-protocol/src/schema/push.ts";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { createApplicationGateway } from "../test-helpers/application-context-fixtures.ts";
import { restorePropertyDescriptor } from "../test-helpers/property-descriptor.ts";
import type { ApplicationGatewaySnapshot } from "./gateway.ts";
import { createWebPushCapability } from "./web-push.ts";

const originalServiceWorkerDescriptor = Object.getOwnPropertyDescriptor(navigator, "serviceWorker");

function encodedVapidKey(bytes: number[]): string {
  return Buffer.from(bytes).toString("base64url");
}

function gatewayHarness() {
  const { gateway, publish } = createApplicationGateway({
    phase: "connecting",
    client: null,
  } as unknown as ApplicationGatewaySnapshot);
  gateway.subscribeEvents = () => () => {};
  return {
    gateway,
    connect(client: GatewayBrowserClient) {
      publish({
        ...gateway.snapshot,
        phase: "connected",
        client,
        selfUser: { id: "profile-owner" },
        hello: {
          auth: { role: "operator", scopes: ["operator.admin"] },
          features: { methods: ["push.web.preferences.get", "push.web.preferences.set"] },
        },
      } as unknown as ApplicationGatewaySnapshot);
    },
  };
}

function notificationPreferences(): WebPushNotificationPreferences {
  return {
    categories: {
      approvalRequested: false,
      agentFinished: false,
      agentQuestion: false,
      humanMentioned: false,
      scheduledTaskFailed: false,
    },
    detailLevel: "private",
    quietHours: { enabled: false, startMinute: 1_320, endMinute: 420, timeZone: "UTC" },
    agentIds: [],
  };
}

function preferenceResult(user: WebPushNotificationPreferences) {
  return {
    durableIdentity: true,
    user,
    device: { enabled: true, label: "" },
    effective: { ...user, enabled: true, label: "" },
  };
}

describe("web push preference saves", () => {
  beforeEach(() => {
    const vapidBytes = [4, 1, 2, 3];
    const subscription = {
      endpoint: "https://push.example.test/subscription",
      options: {
        applicationServerKey: Uint8Array.from(vapidBytes).buffer,
        userVisibleOnly: true,
      },
      toJSON: () => ({
        endpoint: "https://push.example.test/subscription",
        keys: { p256dh: "p256dh", auth: "auth" },
      }),
    } as unknown as PushSubscription;
    const registration = {
      pushManager: { getSubscription: vi.fn().mockResolvedValue(subscription) },
    };
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        ready: Promise.resolve(registration),
        getRegistration: async () => registration,
      },
    });
    vi.stubGlobal("PushManager", vi.fn());
    vi.stubGlobal("Notification", { permission: "granted" });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    restorePropertyDescriptor(navigator, "serviceWorker", originalServiceWorkerDescriptor);
  });

  it("rebases a queued preference edit onto the earlier queued save", async () => {
    const firstSave = createDeferred();
    const saved = notificationPreferences();
    let stored = saved;
    let saveCount = 0;
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "push.web.vapidPublicKey") {
        return { vapidPublicKey: encodedVapidKey([4, 1, 2, 3]) };
      }
      if (method === "push.web.preferences.get") {
        return preferenceResult(stored);
      }
      if (method === "push.web.preferences.set") {
        saveCount += 1;
        if (saveCount === 1) {
          await firstSave.promise;
        }
        stored = (params as { preferences: WebPushNotificationPreferences }).preferences;
        return { scope: "user", preferences: stored };
      }
      return {};
    });
    const harness = gatewayHarness();
    const capability = createWebPushCapability(harness.gateway);
    harness.connect({ request } as unknown as GatewayBrowserClient);
    await vi.waitFor(() => expect(capability.snapshot.preferences).toBeTruthy());

    // Both toggles were built from the same rendered preferences before either save returned.
    const toggle = (category: "agentFinished" | "agentQuestion") => ({
      ...saved,
      categories: { ...saved.categories, [category]: true },
    });
    const first = capability.run({
      kind: "set",
      scope: "user",
      preferences: toggle("agentFinished"),
    });
    await vi.waitFor(() => expect(saveCount).toBe(1));
    const second = capability.run({
      kind: "set",
      scope: "user",
      preferences: toggle("agentQuestion"),
    });
    firstSave.resolve();
    await Promise.all([first, second]);

    expect(stored.categories).toMatchObject({ agentFinished: true, agentQuestion: true });
    expect(capability.snapshot.preferences?.user.categories).toMatchObject({
      agentFinished: true,
      agentQuestion: true,
    });
    capability.dispose();
  });
});
