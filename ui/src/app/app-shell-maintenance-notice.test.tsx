/* @vitest-environment jsdom */
import { createSignal, flush } from "solid-js";
import { expect, it, vi } from "vitest";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { GatewayMaintenanceBanner } from "./app-shell-maintenance-notice.tsx";
import type { ApplicationGatewaySnapshot } from "./gateway.ts";

type BannerSnapshot = Pick<ApplicationGatewaySnapshot, "phase" | "maintenance" | "client">;

// Fork: maintenance mode banner with its Resume chats button.
it("shows the maintenance banner while chats are paused and resumes them by button", async () => {
  const request = vi.fn(async () => ({ resumed: true }));
  const client = { request } as unknown as ApplicationGatewaySnapshot["client"];
  const [snapshot, setSnapshot] = createSignal<BannerSnapshot>({
    phase: "connected",
    client,
    maintenance: { since: Date.now(), source: "installer", reason: "OpenClaw update", untilMs: null },
  });
  const view = mountSolid(() => <GatewayMaintenanceBanner snapshot={snapshot} />);
  const banner = () => view.container.querySelector(".shell-maintenance-notice");
  expect(banner()?.textContent).toContain("Maintenance: chats paused (OpenClaw update");
  expect(banner()?.textContent).toContain("by installer");
  expect(banner()?.textContent).toContain("Messages you send wait");
  expect(banner()?.textContent).toContain("An install or update is running");

  const button = view.container.querySelector<HTMLButtonElement>(".shell-maintenance-notice__resume");
  expect(button?.textContent).toContain("Resume chats");
  button?.click();
  await Promise.resolve();
  expect(request).toHaveBeenCalledWith("gateway.maintenance.exit", {});

  // The banner follows the gateway.maintenance event, not the request.
  setSnapshot({ phase: "connected", client, maintenance: null });
  flush();
  expect(banner()).toBeNull();
});

it("shows nothing while disconnected", () => {
  const view = mountSolid(() => (
    <GatewayMaintenanceBanner
      snapshot={() => ({
        phase: "reconnecting",
        client: null,
        maintenance: { since: 1, source: "control-ui", reason: "x", untilMs: null },
      })}
    />
  ));
  expect(view.container.querySelector(".shell-maintenance-notice")).toBeNull();
});
