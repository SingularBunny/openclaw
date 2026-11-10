// Fork (F49): Claude Code permission mode picker in the composer of `claude-cli` sessions.
import { For, Show, createSignal } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { registerClaudeComposerEnglish } from "../../../i18n/locales/en-claude-composer.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import {
  CLAUDE_MODE_ICONS,
  CLAUDE_MODES,
  readClaudePermissionMode,
  type ChatClaudeModePickerProps,
  type ClaudePermissionMode,
} from "./chat-claude-mode.ts";
import { restorePointerOpenedChatComposerTrigger } from "./chat-picker-overlay.ts";

registerClaudeComposerEnglish();

const UNSET_VALUE = "unset";
const OPTIONS = [null, ...CLAUDE_MODES] as const;

function selectionFor(value: string | undefined): ClaudePermissionMode | null | undefined {
  return value === UNSET_VALUE ? null : readClaudePermissionMode(value);
}

export function claudeModeLabel(mode: ClaudePermissionMode | null | undefined): string {
  return t(`chat.claudeMode.modes.${mode ?? "unset"}.label`);
}

export function ChatClaudeModePicker(props: ChatClaudeModePickerProps) {
  const [opened, setOpened] = createSignal(false);
  const disabled = () => Boolean(props.disabled || props.pending);
  const select = (mode: ClaudePermissionMode | null) => {
    if (
      disabled() ||
      (mode === "bypassPermissions" && !props.canSelectBypass) ||
      mode === (props.mode ?? null)
    ) {
      return;
    }
    void props.onSelect(mode);
  };
  return (
    <wa-dropdown
      class="chat-controls__inline-select chat-controls__claude-mode-picker"
      placement="top-start"
      onWa-show={() => setOpened(true)}
      onWa-after-show={restorePointerOpenedChatComposerTrigger}
      onWa-select={(event: CustomEvent<{ item: { value?: string } }>) => {
        const mode = selectionFor(event.detail.item.value);
        if (mode !== undefined) {
          select(mode);
        }
      }}
    >
      <button
        slot="trigger"
        type="button"
        class={[
          "chat-controls__inline-select-trigger chat-controls__claude-mode-trigger",
          { "chat-controls__inline-select-trigger--disabled": props.disabled },
        ]}
        data-chat-claude-mode-select="true"
        data-chat-select-value={props.mode ?? ""}
        aria-label={`${t("chat.claudeMode.label")}: ${claudeModeLabel(props.mode)}`}
        aria-disabled={disabled() ? "true" : "false"}
        title={props.disabledReason ?? t("chat.claudeMode.help")}
        disabled={disabled()}
      >
        <span class="chat-controls__permission-icon" aria-hidden="true">
          <Icon name={props.mode ? CLAUDE_MODE_ICONS[props.mode] : "bot"} />
        </span>
        <Show when={props.mode}>
          {(mode) => <span class="chat-controls__claude-mode-text">{claudeModeLabel(mode())}</span>}
        </Show>
      </button>
      <Show when={opened()}>
        <div class="chat-controls__popover-title chat-controls__permission-heading">
          {t("chat.claudeMode.label")}
        </div>
        <For each={OPTIONS}>
          {(mode) => {
            const value = mode ?? UNSET_VALUE;
            const selected = () => (props.mode ?? null) === mode;
            const locked = () => mode === "bypassPermissions" && !props.canSelectBypass;
            return (
              <wa-dropdown-item
                class={[
                  "chat-controls__permission-option",
                  { "chat-controls__permission-option--selected": selected() },
                ]}
                value={value}
                data-chat-claude-mode-option={value}
                role="menuitemradio"
                aria-checked={selected() ? "true" : "false"}
                title={locked() ? t("chat.claudeMode.bypassRequiresAdmin") : undefined}
                disabled={disabled() || locked()}
              >
                <span slot="icon" class="chat-controls__permission-option-icon" aria-hidden="true">
                  <Icon name={mode ? CLAUDE_MODE_ICONS[mode] : "bot"} />
                </span>
                <span class="chat-controls__permission-option-copy">
                  <span class="chat-controls__permission-option-title">
                    <span>{claudeModeLabel(mode)}</span>
                  </span>
                  <span class="chat-controls__permission-option-description">
                    {t(`chat.claudeMode.modes.${value}.description`)}
                  </span>
                </span>
                <span
                  slot="details"
                  class="chat-controls__permission-option-state"
                  aria-hidden="true"
                >
                  <Show when={locked()}>
                    <span class="chat-controls__permission-lock">
                      <Icon name="lock" />
                    </span>
                  </Show>
                  <Show when={selected()}>
                    <span class="chat-controls__inline-select-check">
                      <Icon name="check" />
                    </span>
                  </Show>
                </span>
              </wa-dropdown-item>
            );
          }}
        </For>
      </Show>
    </wa-dropdown>
  );
}
