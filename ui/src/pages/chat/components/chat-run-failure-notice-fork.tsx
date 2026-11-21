// Fork: an expired Claude CLI login shows the re-login command and a Model Setup button in the run
// failure notice. Kept out of chat-run-failure-notice.tsx so upstream changes there merge without
// conflicts.
import { Show } from "solid-js";
import { CopyButton } from "../../../components/solid/copy-button.tsx";
import { Icon } from "../../../components/solid/icon.tsx";
import { CLAUDE_CLI_LOGIN_COMMAND } from "../../../lib/chat/claude-cli-login.ts";
import { t } from "../../../lib/reactive/i18n.ts";

export function ClaudeCliLoginHint(props: { onOpenModelSetup?: () => void }) {
  return (
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
  );
}
