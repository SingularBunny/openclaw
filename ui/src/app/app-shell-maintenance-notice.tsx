import { createMemo, createSignal, Show } from "solid-js";
import { t } from "../lib/reactive/i18n.ts";
import { resolveGatewayMaintenanceBanner } from "./gateway-maintenance-notice.ts";
import type { ApplicationGatewaySnapshot } from "./gateway.ts";
import "./app-shell-fork-notices.css";

/**
 * Fork: app-level banner while maintenance mode pauses chats, with a Resume chats button
 * (`gateway.maintenance.exit`). It stays until maintenance ends; it cannot be dismissed.
 */
export function GatewayMaintenanceBanner(props: {
  snapshot: () => Pick<ApplicationGatewaySnapshot, "phase" | "maintenance" | "client">;
}) {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const banner = createMemo(() => resolveGatewayMaintenanceBanner(props.snapshot(), t));
  const resume = async () => {
    const client = props.snapshot().client;
    if (!client || busy()) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await client.request("gateway.maintenance.exit", {});
    } catch (err) {
      setError(
        t("common.gatewayMaintenance.failed", {
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <Show when={banner()}>
      {(current) => (
        <div
          class="shell-restart-notice shell-restart-notice--warn shell-maintenance-notice"
          role="status"
          aria-live="polite"
          data-kind="maintenance"
        >
          <span class="shell-restart-notice__text">
            {current().text}
            <Show when={current().hint}>
              {(hint) => <span class="shell-maintenance-notice__hint"> {hint()}</span>}
            </Show>
            <Show when={error()}>
              {(message) => <span class="shell-maintenance-notice__error"> {message()}</span>}
            </Show>
          </span>
          <button
            type="button"
            class="btn btn--sm shell-maintenance-notice__resume"
            disabled={busy()}
            onClick={() => void resume()}
          >
            {busy()
              ? t("common.gatewayMaintenance.resuming")
              : t("common.gatewayMaintenance.resume")}
          </button>
        </div>
      )}
    </Show>
  );
}
