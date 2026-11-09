/* @vitest-environment jsdom */
import { createSignal, flush } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { GatewayRestartNoticeBanner } from "./app-shell-restart-notice.tsx";
import type { ApplicationGatewaySnapshot } from "./gateway.ts";

afterEach(() => vi.useRealTimers());

type NoticeSnapshot = Pick<
  ApplicationGatewaySnapshot,
  "phase" | "restartPending" | "restartNotice" | "restartedAt"
>;

// Fork: the restart notice is an app-level status line, not a chat row.
it("shows a pending restart live, then restarting, then restarted until it expires", () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const [snapshot, setSnapshot] = createSignal<NoticeSnapshot>({
    phase: "connected",
    restartNotice: {
      phase: "pending",
      reason: "config reload: env.vars.OPENCLAW_X",
      since: 0,
      deadlineAt: 30 * 60_000,
      activeTurns: 2,
      activeWork: 2,
    },
  });
  const view = mountSolid(() => <GatewayRestartNoticeBanner snapshot={snapshot} />);
  const text = () => view.container.querySelector(".shell-restart-notice")?.textContent ?? "";
  expect(text()).toContain("Gateway restart pending: waiting for 2 running turns");
  expect(text()).toContain("at most in 30 min");
  expect(text()).toContain("(reason: env.vars.OPENCLAW_X)");
  expect(view.container.querySelector("[role=status]")).not.toBeNull();

  vi.advanceTimersByTime(5 * 60_000);
  flush();
  expect(text()).toContain("at most in 25 min");

  setSnapshot({ phase: "reconnecting", restartPending: true });
  flush();
  expect(text()).toContain("Gateway restarting now");

  setSnapshot({ phase: "connected", restartedAt: Date.now() });
  flush();
  expect(text()).toContain("Gateway restarted");
  vi.advanceTimersByTime(10_000);
  flush();
  expect(view.container.querySelector(".shell-restart-notice")).toBeNull();
});

it("can be dismissed until the notice changes", () => {
  const [snapshot, setSnapshot] = createSignal<NoticeSnapshot>({
    phase: "connected",
    restartNotice: {
      phase: "pending",
      reason: "r",
      since: 1,
      deadlineAt: null,
      activeTurns: 1,
      activeWork: 1,
    },
  });
  const view = mountSolid(() => <GatewayRestartNoticeBanner snapshot={snapshot} />);
  expect(view.container.textContent).toContain(
    "waiting for 1 running turn, restarts when they finish",
  );
  view.getByRole("button", { name: "Dismiss" }).click();
  flush();
  expect(view.container.querySelector(".shell-restart-notice")).toBeNull();
  setSnapshot({ phase: "reconnecting", restartPending: true });
  flush();
  expect(view.container.textContent).toContain("Gateway restarting now");
});
