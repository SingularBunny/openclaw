import type { JSX } from "@solidjs/web";
import {
  createMemo,
  createRenderEffect,
  createSignal,
  For,
  onCleanup,
  Show,
  untrack,
} from "solid-js";
import type { UsageSummary } from "../../../src/infra/provider-usage.types.js";
import type { ApplicationGateway } from "../app/gateway.ts";
import { formatDateTimeMs, formatRelativeTimestamp } from "../lib/format.ts";
import { canCallGatewayMethod } from "../lib/gateway-methods.ts";
import { requestProviderUsage } from "../lib/provider-usage-request.ts";
import { t } from "../lib/reactive/i18n.ts";
import "../styles/claude-usage.css";
import {
  formatClaudeUsageCountdown,
  rememberClaudeUsage,
  resolveClaudeUsageView,
  type ClaudeUsageLastGood,
  type ClaudeUsageRow,
} from "./claude-usage-indicator-model.ts";
import { publishSharedClaudeUsage } from "./claude-usage-store.ts";

/**
 * usage.status is answered from the Gateway's minute cache, so this poll never reaches the
 * provider more than once a minute; it only picks up a fresh cache and live turn status.
 */
export const CLAUDE_USAGE_POLL_MS = 30_000;
/** A finished turn may carry a rate-limit event; re-read shortly after it ends. */
const TURN_END_REFRESH_DELAY_MS = 1_500;
const CLOCK_TICK_MS = 30_000;
/** A cold Gateway answers "refreshing" first; look again soon instead of a full poll later. */
const COLD_RETRY_MS = 3_000;

function isTurnEndEvent(event: { event: string; payload?: unknown }): boolean {
  if (event.event !== "chat") {
    return false;
  }
  const state = (event.payload as { state?: unknown } | undefined)?.state;
  return state === "final" || state === "error" || state === "aborted";
}

function resetTitle(resetAt: number): string {
  return t("common.claudeUsage.resetsAt", {
    relative: formatRelativeTimestamp(resetAt),
    time: formatDateTimeMs(resetAt),
  });
}

/**
 * Fork: always-visible Claude subscription limits (5-hour, weekly, per-model windows) with
 * reset times. Hidden while the Gateway reports no Claude subscription data.
 */
export function ClaudeUsageIndicator(props: {
  gateway: () => ApplicationGateway | undefined;
}): JSX.Element {
  const [summary, setSummary] = createSignal<UsageSummary | null>(null);
  const [lastGood, setLastGood] = createSignal<ClaudeUsageLastGood | null>(null);
  const [now, setNow] = createSignal(Date.now());
  let inFlight: AbortController | null = null;
  let turnEndTimer: ReturnType<typeof setTimeout> | undefined;
  let coldRetryTimer: ReturnType<typeof setTimeout> | undefined;
  let haveSummary = false;
  let boundGateway: ApplicationGateway | undefined;
  let unsubscribe: Array<() => void> = [];

  // Polling and subscriptions own refreshes; the gateway accessor is read, never tracked.
  const currentGateway = () => untrack(() => props.gateway());

  const refresh = () => {
    const snapshot = currentGateway()?.snapshot;
    const client = snapshot?.client;
    // Only Gateways that advertise usage.status to this operator are asked.
    if (!client || !canCallGatewayMethod(snapshot, "usage.status", "operator.read")) {
      return;
    }
    if (typeof document !== "undefined" && document.visibilityState === "hidden") {
      return;
    }
    inFlight?.abort();
    const controller = new AbortController();
    inFlight = controller;
    requestProviderUsage(client, { signal: controller.signal })
      .then((result) => {
        if (inFlight !== controller) {
          return;
        }
        inFlight = null;
        // Keep the last good values on a failed or malformed read; usage is auxiliary.
        if (!result.ok || !Array.isArray(result.value?.providers)) {
          return;
        }
        if (result.value.refreshing) {
          clearTimeout(coldRetryTimer);
          coldRetryTimer = setTimeout(refresh, COLD_RETRY_MS);
          return;
        }
        haveSummary = true;
        const at = Date.now();
        setLastGood((previous) => rememberClaudeUsage(previous, result.value, at));
        setSummary(result.value);
        setNow(at);
      })
      .catch(() => {});
  };

  /** Follows the current Gateway; returns true when it (re)bound and already refreshed. */
  const bind = (): boolean => {
    const gateway = currentGateway();
    if (gateway === boundGateway) {
      return false;
    }
    for (const stop of unsubscribe) {
      stop();
    }
    unsubscribe = [];
    boundGateway = gateway;
    if (haveSummary) {
      // Another Gateway's figures must not linger under this connection.
      haveSummary = false;
      setSummary(null);
      setLastGood(null);
    }
    if (!gateway) {
      return false;
    }
    let lastPhase = gateway.snapshot.phase;
    unsubscribe.push(
      gateway.subscribe((snapshot) => {
        if (snapshot.phase === "connected" && lastPhase !== "connected") {
          refresh();
        }
        lastPhase = snapshot.phase;
      }),
      gateway.subscribeEvents((event) => {
        if (!isTurnEndEvent(event)) {
          return;
        }
        clearTimeout(turnEndTimer);
        turnEndTimer = setTimeout(refresh, TURN_END_REFRESH_DELAY_MS);
      }),
    );
    refresh();
    return true;
  };

  bind();
  const poll = setInterval(() => {
    if (!bind()) {
      refresh();
    }
  }, CLAUDE_USAGE_POLL_MS);
  const clock = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
  const onVisible = () => {
    if (document.visibilityState === "visible" && !bind()) {
      refresh();
    }
  };
  document.addEventListener("visibilitychange", onVisible);
  onCleanup(() => {
    clearInterval(poll);
    clearInterval(clock);
    clearTimeout(turnEndTimer);
    clearTimeout(coldRetryTimer);
    document.removeEventListener("visibilitychange", onVisible);
    inFlight?.abort();
    for (const stop of unsubscribe) {
      stop();
    }
  });

  const view = createMemo(() => resolveClaudeUsageView(summary(), now(), t, lastGood()));
  // Fork (F48): the composer status line reads the same figures.
  createRenderEffect(view, (current) => publishSharedClaudeUsage(current));
  onCleanup(() => publishSharedClaudeUsage(null));

  return (
    <Show when={view()}>
      {(current) => (
        <section
          class="claude-usage"
          aria-label={t("common.claudeUsage.title")}
          data-limit={current().rateLimit?.status}
          data-stale={current().staleSince !== undefined ? "" : undefined}
        >
          <div class="claude-usage__header">
            <span class="claude-usage__title">
              {current().plan
                ? t("common.claudeUsage.titleWithPlan", { plan: current().plan ?? "" })
                : t("common.claudeUsage.title")}
            </span>
            <Show when={current().staleSince}>
              {(since) => (
                <span class="claude-usage__stale" title={formatDateTimeMs(since())}>
                  {t("common.claudeUsage.updated", {
                    relative: formatRelativeTimestamp(since()),
                  })}
                </span>
              )}
            </Show>
          </div>
          <Show when={current().rateLimit}>
            {(limit) => (
              <div
                class={[
                  "claude-usage__status",
                  limit().status === "rejected"
                    ? "claude-usage__status--danger"
                    : "claude-usage__status--warn",
                ]}
                role="status"
                title={limit().resetAt !== undefined ? resetTitle(limit().resetAt ?? 0) : undefined}
              >
                {limit().status === "rejected"
                  ? limit().label
                    ? t("common.claudeUsage.limitReachedWindow", { label: limit().label ?? "" })
                    : t("common.claudeUsage.limitReached")
                  : limit().label
                    ? t("common.claudeUsage.approachingWindow", { label: limit().label ?? "" })
                    : t("common.claudeUsage.approaching")}
                <Show when={limit().resetAt}>
                  {(resetAt) => (
                    <span class="claude-usage__status-reset">
                      {" · "}
                      {t("common.claudeUsage.resetsIn", {
                        countdown: formatClaudeUsageCountdown(resetAt(), now()),
                      })}
                    </span>
                  )}
                </Show>
              </div>
            )}
          </Show>
          <ul class="claude-usage__rows">
            <For each={current().rows} keyed={(row: ClaudeUsageRow) => row.key}>
              {(row) => (
                <li
                  class={["claude-usage__row", `claude-usage__row--${row().tone}`]}
                  title={row().resetAt !== undefined ? resetTitle(row().resetAt ?? 0) : undefined}
                  aria-label={t("common.claudeUsage.percentUsed", {
                    label: row().label,
                    percent: String(row().percent),
                  })}
                >
                  <span class="claude-usage__label">{row().label}</span>
                  <span class="claude-usage__bar" aria-hidden="true">
                    <span class="claude-usage__fill" style={{ width: `${row().percent}%` }} />
                  </span>
                  <span class="claude-usage__percent">{row().percent}%</span>
                  <span class="claude-usage__reset">
                    {row().resetAt !== undefined
                      ? formatClaudeUsageCountdown(row().resetAt ?? 0, now())
                      : ""}
                  </span>
                </li>
              )}
            </For>
          </ul>
        </section>
      )}
    </Show>
  );
}
