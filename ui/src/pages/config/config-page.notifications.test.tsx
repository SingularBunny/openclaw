/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebPushNotificationPreferences } from "../../../../packages/gateway-protocol/src/schema/push.ts";
import { resolveThemeBranding } from "../../../../packages/gateway-protocol/src/theme.ts";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { createWebPushCapability } from "../../app/web-push.ts";
import { createApplicationGateway } from "../../test-helpers/application-context.ts";
import { cleanupSolid } from "../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { mountConfigPage } from "./config-page.test-support.ts";

const originalServiceWorkerDescriptor = Object.getOwnPropertyDescriptor(
  Navigator.prototype,
  "serviceWorker",
);
const vapidKey = [4, 1, 2, 3];
const endpoint = "https://push.example.test/subscription";

function savedPreferences(): WebPushNotificationPreferences {
  return {
    categories: {
      approvalRequested: true,
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

type Handler = (params: unknown) => Promise<unknown>;

/** A connected Gateway whose Web Push methods tests can hold open. */
function pushGateway(overrides: Record<string, Handler> = {}) {
  let user = savedPreferences();
  const request = vi.fn(async (method: string, params?: unknown) => {
    const override = overrides[method];
    if (override) {
      return await override(params);
    }
    switch (method) {
      case "push.web.vapidPublicKey":
        return { vapidPublicKey: Buffer.from(vapidKey).toString("base64url") };
      case "push.web.subscribe":
        return { subscriptionId: "subscription-1" };
      case "push.web.preferences.get":
        return {
          durableIdentity: true,
          user,
          device: { enabled: true, label: "" },
          effective: { ...user, enabled: true, label: "" },
        };
      case "push.web.preferences.set":
        user = (params as { preferences: WebPushNotificationPreferences }).preferences;
        return { scope: "user", preferences: user };
      default:
        return {};
    }
  });
  const client = { request } as unknown as GatewayBrowserClient;
  const { gateway } = createApplicationGateway({
    client,
    phase: "connected",
    offlineStable: true,
    hello: null,
    canvasPluginSurfaceUrl: null,
    assistantAgentId: "main",
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
    selfUser: { id: "profile-owner" },
  } as unknown as Parameters<typeof createApplicationGateway>[0]);
  return { gateway, request, saved: () => user };
}

function mountNotifications(
  gateway: ApplicationContext["gateway"],
  webPush = createWebPushCapability(gateway),
) {
  const subscribe = () => () => undefined;
  const context = {
    basePath: "",
    gateway,
    settingsAgentSelection: { state: { selectedId: "main" }, subscribe },
    agentSelection: { state: { selectedId: "main" }, subscribe },
    agents: { state: { agentsList: null }, subscribe },
    config: { current: { assistantIdentity: { name: "OpenClaw" } }, subscribe },
    runtimeConfig: {
      state: { configSnapshot: null, configSchema: {}, configForm: {}, configRaw: "{}" },
      subscribe,
    },
    theme: { branding: resolveThemeBranding(undefined), serverSelection: null, subscribe },
    overlays: { snapshot: {}, subscribe },
    webPush,
  } as unknown as ApplicationContext;
  const view = mountConfigPage(context, { pageId: "notifications" });
  const button = (label: string) => {
    const match = [...view.container.querySelectorAll("button")].find(
      (entry) => entry.textContent?.trim() === label,
    );
    if (!match) {
      throw new Error(`Missing button ${label}`);
    }
    return match;
  };
  const toggle = (label: string) => {
    const row = [...view.container.querySelectorAll(".settings-row--toggle")].find((entry) =>
      entry.textContent?.includes(label),
    );
    const input = row?.querySelector<HTMLInputElement>("input");
    if (!input) {
      throw new Error(`Missing toggle ${label}`);
    }
    return input;
  };
  return { view, webPush, button, toggle };
}

describe("ConfigPage notifications with the live Web Push owner", () => {
  beforeEach(() => {
    const subscription = {
      endpoint,
      options: { applicationServerKey: Uint8Array.from(vapidKey).buffer, userVisibleOnly: true },
      toJSON: () => ({ endpoint, keys: { p256dh: "p256dh", auth: "auth" } }),
    };
    const registration = { pushManager: { getSubscription: async () => subscription } };
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { ready: Promise.resolve(registration), getRegistration: async () => registration },
    });
    vi.stubGlobal("PushManager", vi.fn());
    vi.stubGlobal("Notification", { permission: "granted" });
  });

  afterEach(() => {
    cleanupSolid();
    vi.unstubAllGlobals();
    if (originalServiceWorkerDescriptor) {
      Object.defineProperty(navigator, "serviceWorker", originalServiceWorkerDescriptor);
    } else {
      Reflect.deleteProperty(navigator, "serviceWorker");
    }
  });

  it("shows the subscription and account defaults when reconciliation finishes after mount", async () => {
    // A direct page load mounts settings before the Gateway reconciliation answers.
    const vapid = createDeferred<unknown>();
    const { gateway } = pushGateway({ "push.web.vapidPublicKey": () => vapid.promise });
    const { view, webPush } = mountNotifications(gateway);
    expect(view.container.textContent).toContain("Checking...");

    vapid.resolve({ vapidPublicKey: Buffer.from(vapidKey).toString("base64url") });
    await vi.waitFor(() => expect(webPush.snapshot.preferences).toBeTruthy());
    flush();

    await waitForSolid(() => {
      expect(view.container.textContent).not.toContain("Checking...");
      expect(view.container.textContent).toContain("Subscribed");
      expect(view.container.textContent).toContain("Account defaults");
    });
    webPush.dispose();
  });

  it("re-enables Send test and Unsubscribe once the test push returns", async () => {
    const test = createDeferred<unknown>();
    const { gateway, request } = pushGateway({ "push.web.test": () => test.promise });
    // Reconcile first, as after in-app navigation, so the page mounts subscribed.
    const owner = createWebPushCapability(gateway);
    await vi.waitFor(() => expect(owner.snapshot.subscription).toBe("registered"));
    const { webPush, button } = mountNotifications(gateway, owner);

    button("Send test").click();
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("push.web.test", {}));
    flush();
    expect(button("Send test").disabled).toBe(true);

    test.resolve({ results: [{ ok: true, statusCode: 201 }] });
    await vi.waitFor(() => expect(webPush.snapshot.loading).toBe(false));
    flush();

    await waitForSolid(() => {
      expect(button("Send test").disabled).toBe(false);
      expect(button("Unsubscribe").disabled).toBe(false);
    });
    webPush.dispose();
  });

  it("keeps an earlier account default when a second toggle follows its save", async () => {
    const { gateway, saved } = pushGateway();
    const owner = createWebPushCapability(gateway);
    await vi.waitFor(() => expect(owner.snapshot.preferences).toBeTruthy());
    const { webPush, toggle } = mountNotifications(gateway, owner);

    toggle("Agent finished").click();
    await vi.waitFor(() => expect(saved().categories.agentFinished).toBe(true));
    await vi.waitFor(() => expect(webPush.snapshot.loading).toBe(false));
    flush();
    toggle("Agent question").click();
    await vi.waitFor(() => expect(saved().categories.agentQuestion).toBe(true));

    expect(saved().categories).toMatchObject({ agentFinished: true, agentQuestion: true });
    webPush.dispose();
  });
});
