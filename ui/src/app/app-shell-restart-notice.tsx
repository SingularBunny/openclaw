import { createMemo, createSignal, onCleanup, Show } from "solid-js";
import { t } from "../lib/reactive/i18n.ts";
import { resolveGatewayRestartBanner } from "./gateway-restart-notice.ts";
import type { ApplicationGatewaySnapshot } from "./gateway.ts";

/** Countdown and "restarted" expiry granularity. */
const TICK_MS = 5_000;

/**
 * Fork: app-level notice of a Gateway restart that waits for running work, outside any chat:
 * pending (what it waits for, latest restart time, reason), restarting now, and restarted after
 * the reconnect. The operator can dismiss it; a new state shows again.
 */
export function GatewayRestartNoticeBanner(props: {
  snapshot: () => Pick<
    ApplicationGatewaySnapshot,
    "phase" | "restartPending" | "restartNotice" | "restartedAt"
  >;
}) {
  const now = Date.now;
  const [tick, setTick] = createSignal(now());
  const timer = globalThis.setInterval(() => setTick(now()), TICK_MS);
  onCleanup(() => globalThis.clearInterval(timer));
  const [dismissed, setDismissed] = createSignal<string | null>(null);
  const banner = createMemo(() => {
    const snapshot = props.snapshot();
    // Re-read the clock on every snapshot change too, not only on the tick.
    tick();
    const next = resolveGatewayRestartBanner(snapshot, now(), t);
    if (!next) {
      return null;
    }
    const identity = `${next.kind}:${snapshot.restartNotice?.since ?? snapshot.restartedAt ?? ""}`;
    return identity === dismissed() ? null : { ...next, identity };
  });
  return (
    <Show when={banner()}>
      {(current) => (
        <div
          class={`shell-restart-notice shell-restart-notice--${current().tone}`}
          role="status"
          aria-live="polite"
          data-kind={current().kind}
        >
          <span class="shell-restart-notice__text">{current().text}</span>
          <button
            type="button"
            class="shell-restart-notice__dismiss"
            aria-label={t("common.gatewayRestart.dismiss")}
            onClick={() => setDismissed(current().identity)}
          >
            ×
          </button>
        </div>
      )}
    </Show>
  );
}
