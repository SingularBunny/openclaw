import { createMemo, Show } from "solid-js";
import { formatWebUiIconErrorText } from "../../../components/error-presentation.ts";
import { CopyButton } from "../../../components/solid/copy-button.tsx";
import { Icon } from "../../../components/solid/icon.tsx";
import { registerClaudeCliLoginEnglish } from "../../../i18n/locales/en-claude-cli-login.ts";
import {
  CLAUDE_CLI_LOGIN_COMMAND,
  isClaudeCliLoginExpiredText,
} from "../../../lib/chat/claude-cli-login.ts";
import { t } from "../../../lib/reactive/i18n.ts";

registerClaudeCliLoginEnglish();

/** One terminal notice, separate from assistant prose and preserved partial output. */
export function ChatRunFailureNotice(props: {
  summary: string;
  repeatCount?: number;
  onRetry?: () => void;
  /** Fork: opens Settings → Model Setup; shown with the Claude CLI re-login hint. */
  onOpenModelSetup?: () => void;
}) {
  const detail = createMemo(() => formatWebUiIconErrorText(props.summary).trim());
  const concise = createMemo(() => {
    const firstLine = detail().split(/\r?\n/u)[0] ?? "";
    return firstLine.length <= 240 ? firstLine : t("chat.recovery.failedHelp");
  });
  const claudeLogin = createMemo(() => isClaudeCliLoginExpiredText(props.summary));
  return (
    <openclaw-chat-run-failure-notice style={{ display: "contents" }}>
      <div class="chat-run-failure" role="status">
        <span class="chat-run-failure__icon" aria-hidden="true">
          <Icon name="circleX" />
        </span>
        <div class="chat-run-failure__content">
          <div class="chat-run-failure__header">
            <div class="chat-run-failure__heading">
              <strong class="chat-run-failure__title">
                {claudeLogin() ? t("common.claudeCliLogin.title") : t("chat.recovery.failedTitle")}
              </strong>
              <Show when={(props.repeatCount ?? 1) > 1}>
                <span class="chat-run-failure__repeat">
                  · {t("chat.recovery.failedRepeatCount", { count: String(props.repeatCount) })}
                </span>
              </Show>
              <span class="chat-run-failure__copy">
                <CopyButton text={props.summary} idleLabel={t("chat.copyError")} bare />
              </span>
            </div>
            <Show when={props.onRetry}>
              <button
                type="button"
                class="btn primary btn--sm chat-run-failure__retry"
                onClick={() => props.onRetry?.()}
              >
                <Icon name="refresh" />
                {t("chat.recovery.tryAgain")}
              </button>
            </Show>
          </div>
          <Show
            when={claudeLogin()}
            fallback={<p class="chat-run-failure__summary">{concise()}</p>}
          >
            <div class="chat-run-failure__login" data-claude-cli-login="">
              <p class="chat-run-failure__summary">{t("common.claudeCliLogin.body")}</p>
              <div class="chat-run-failure__login-command">
                <code>{CLAUDE_CLI_LOGIN_COMMAND}</code>
                <CopyButton
                  text={CLAUDE_CLI_LOGIN_COMMAND}
                  idleLabel={t("common.claudeCliLogin.copyCommand")}
                />
                <Show when={props.onOpenModelSetup}>
                  <button
                    type="button"
                    class="btn btn--sm"
                    data-claude-cli-login-setup=""
                    onClick={() => props.onOpenModelSetup?.()}
                  >
                    <Icon name="settings" />
                    {t("common.claudeCliLogin.openModelSetup")}
                  </button>
                </Show>
              </div>
            </div>
          </Show>
          <Show when={detail() !== concise()}>
            <details class="chat-run-failure__details">
              <summary>{t("chat.details")}</summary>
              <p>{t("chat.recovery.failedHelp")}</p>
              <pre tabindex="0" aria-label={t("chat.errorDetails")}>
                {detail()}
              </pre>
            </details>
          </Show>
        </div>
      </div>
    </openclaw-chat-run-failure-notice>
  );
}
