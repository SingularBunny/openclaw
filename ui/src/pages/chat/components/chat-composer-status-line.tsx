// Fork (F48): one compact session status line under the chat composer, like Claude Code's.
import { createMemo, createRenderEffect, createSignal, Show } from "solid-js";
import type { GatewaySessionRow } from "../../../api/types.ts";
import { formatClaudeUsageCountdown } from "../../../components/claude-usage-indicator-model.ts";
import { readSharedClaudeUsage } from "../../../components/claude-usage-store.ts";
import { registerClaudeComposerEnglish } from "../../../i18n/locales/en-claude-composer.ts";
import { isMonitoredAuthProvider } from "../../../lib/model-auth.ts";
import {
  collectProviderQuotaGroups,
  type ProviderUsageDisplayProps,
} from "../../../lib/provider-quota-summary.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import "../../../styles/chat/composer-status-line.css";
import {
  formatTurnElapsed,
  hasComposerStatusLineParts,
  resolveComposerStatusLine,
} from "./chat-composer-status-line-model.ts";

registerClaudeComposerEnglish();

const TURN_CLOCK_TICK_MS = 1_000;

export function ComposerStatusLine(props: {
  session?: GatewaySessionRow;
  runActive?: boolean;
  providerUsage?: ProviderUsageDisplayProps;
  permissionMode?: string | null;
  claudeMode?: string | null;
}) {
  const [now, setNow] = createSignal(Date.now(), { ownedWrite: true });
  // The clock runs only while a turn is running; the other parts follow their own data.
  createRenderEffect(
    () => Boolean(props.runActive),
    (active) => {
      setNow(Date.now());
      if (!active) {
        return undefined;
      }
      const timer = setInterval(() => setNow(Date.now()), TURN_CLOCK_TICK_MS);
      return () => clearInterval(timer);
    },
  );
  const quotaGroups = createMemo(() =>
    collectProviderQuotaGroups(
      props.providerUsage?.modelAuthStatusResult ?? null,
      isMonitoredAuthProvider,
    ),
  );
  const view = createMemo(() =>
    resolveComposerStatusLine({
      session: props.session,
      runActive: props.runActive,
      now: now(),
      claudeUsage: readSharedClaudeUsage(),
      quotaGroups: quotaGroups(),
      permissionMode: props.permissionMode,
      claudeMode: props.claudeMode,
    }),
  );
  const fiveHourTitle = () => {
    const fiveHour = view().fiveHour;
    if (!fiveHour) {
      return "";
    }
    const percent = String(fiveHour.percent);
    return fiveHour.resetAt !== undefined
      ? t("chat.composerStatus.fiveHourReset", {
          percent,
          countdown: formatClaudeUsageCountdown(fiveHour.resetAt, now()),
        })
      : t("chat.composerStatus.fiveHourTitle", { percent });
  };
  return (
    <Show when={hasComposerStatusLineParts(view())}>
      <div
        class="agent-chat__status-line"
        data-chat-status-line="true"
        aria-label={t("chat.composerStatus.label")}
      >
        <Show when={view().model}>
          {(model) => (
            <span
              class="agent-chat__status-line-part agent-chat__status-line-model"
              title={t("chat.composerStatus.model", { model: model() })}
            >
              {model()}
            </span>
          )}
        </Show>
        <Show when={view().context}>
          {(context) => (
            <span
              class="agent-chat__status-line-part"
              data-tone={context().warning ? "warn" : undefined}
              title={t("chat.composerStatus.contextTitle", {
                detail: context().detail,
                pct: String(context().pct),
              })}
            >
              {t("chat.composerStatus.context", {
                pct: `${context().approximate ? "~" : ""}${context().pct}`,
              })}
            </span>
          )}
        </Show>
        <Show when={view().turnElapsedMs !== undefined}>
          <span
            class="agent-chat__status-line-part agent-chat__status-line-turn"
            title={t("chat.composerStatus.turnTitle", {
              elapsed: formatTurnElapsed(view().turnElapsedMs ?? 0),
            })}
          >
            {t("chat.composerStatus.turn", {
              elapsed: formatTurnElapsed(view().turnElapsedMs ?? 0),
            })}
          </span>
        </Show>
        <Show when={view().fiveHour}>
          {(fiveHour) => (
            <span
              class="agent-chat__status-line-part"
              data-tone={fiveHour().tone === "ok" ? undefined : fiveHour().tone}
              title={fiveHourTitle()}
            >
              {fiveHour().reached
                ? t("chat.composerStatus.limitReached")
                : t("chat.composerStatus.fiveHour", { percent: String(fiveHour().percent) })}
            </span>
          )}
        </Show>
        <Show when={view().claudeMode}>
          {(mode) => (
            <span
              class="agent-chat__status-line-part agent-chat__status-line-claude-mode"
              data-claude-mode={mode()}
              data-tone={mode() === "bypassPermissions" ? "warn" : undefined}
              title={t("chat.claudeMode.label")}
            >
              {t(`chat.claudeMode.status.${mode()}`)}
            </span>
          )}
        </Show>
        <Show when={view().permissionMode}>
          {(mode) => (
            <span class="agent-chat__status-line-part agent-chat__status-line-permission">
              {t("chat.composerStatus.permission", {
                mode: t(`chat.permissionControls.modes.${mode()}.label`),
              })}
            </span>
          )}
        </Show>
      </div>
    </Show>
  );
}
