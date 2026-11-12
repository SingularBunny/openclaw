// Fork (F49): Claude Code permission mode picker in the composer of `claude-cli` sessions.
import { createMemo, createUniqueId } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { Menu, type MenuHandle, type MenuItem } from "../../../components/solid/menu.tsx";
import { registerClaudeComposerEnglish } from "../../../i18n/locales/en-claude-composer.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import {
  CLAUDE_MODE_ICONS,
  CLAUDE_MODES,
  readClaudePermissionMode,
  type ChatClaudeModePickerProps,
  type ClaudePermissionMode,
} from "./chat-claude-mode.ts";

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
  const id = createUniqueId();
  let menu: MenuHandle | undefined;
  const disabled = createMemo(() => Boolean(props.disabled || props.pending));
  const select = (mode: ClaudePermissionMode | null) => {
    if (
      disabled() ||
      (mode === "bypassPermissions" && !props.canSelectBypass) ||
      mode === (props.mode ?? null)
    ) {
      menu?.close();
      return;
    }
    void Promise.resolve(props.onSelect(mode)).finally(() => menu?.close());
  };
  const items = createMemo<MenuItem[]>(
    () =>
      OPTIONS.map((mode): MenuItem => {
        const value = mode ?? UNSET_VALUE;
        const selected = (props.mode ?? null) === mode;
        const locked = mode === "bypassPermissions" && !props.canSelectBypass;
        return {
          id: value,
          label: claudeModeLabel(mode),
          type: "radio",
          checked: selected,
          disabled: disabled() || locked,
          closeOnSelect: false,
          class: [
            "chat-controls__permission-option",
            { "chat-controls__permission-option--selected": selected },
          ],
          attributes: {
            "data-chat-claude-mode-option": value,
            title: locked ? t("chat.claudeMode.bypassRequiresAdmin") : undefined,
          },
          icon: (
            <span class="chat-controls__permission-option-icon" aria-hidden="true">
              <Icon name={mode ? CLAUDE_MODE_ICONS[mode] : "bot"} />
            </span>
          ),
          content: (
            <span class="chat-controls__permission-option-copy">
              <span class="chat-controls__permission-option-title">
                <span>{claudeModeLabel(mode)}</span>
              </span>
              <span class="chat-controls__permission-option-description">
                {t(`chat.claudeMode.modes.${value}.description`)}
              </span>
            </span>
          ),
          details: (
            <span class="chat-controls__permission-option-state" aria-hidden="true">
              {locked && (
                <span class="chat-controls__permission-lock">
                  <Icon name="lock" />
                </span>
              )}
              {selected && !locked && (
                <span class="chat-controls__inline-select-check">
                  <Icon name="check" />
                </span>
              )}
            </span>
          ),
        };
      }),
    { lazy: true },
  );
  return (
    <Menu
      lazy
      id={`chat-claude-mode-${id}`}
      label={`${t("chat.claudeMode.label")}: ${claudeModeLabel(props.mode)}`}
      class="chat-controls__inline-select chat-controls__claude-mode-picker"
      panelClass="chat-controls__permission-menu"
      triggerClass={[
        "chat-controls__inline-select-trigger chat-controls__claude-mode-trigger",
        { "chat-controls__inline-select-trigger--disabled": props.disabled },
      ]}
      triggerAttributes={{
        "data-chat-claude-mode-select": "true",
        "data-chat-select-value": props.mode ?? "",
        title: props.disabledReason ?? t("chat.claudeMode.help"),
        "aria-busy": props.pending ? "true" : undefined,
      }}
      disabled={disabled()}
      placement="top-start"
      pointerFocus="trigger"
      items={items()}
      ref={(handle) => {
        menu = handle;
      }}
      onSelect={(item) => {
        const mode = selectionFor(item.id);
        if (mode !== undefined) {
          select(mode);
        }
      }}
      trigger={
        <>
          <span class="chat-controls__permission-icon" aria-hidden="true">
            <Icon name={props.mode ? CLAUDE_MODE_ICONS[props.mode] : "bot"} />
          </span>
          {props.mode && (
            <span class="chat-controls__claude-mode-text">{claudeModeLabel(props.mode)}</span>
          )}
        </>
      }
    >
      <div class="chat-controls__popover-title chat-controls__permission-heading">
        {t("chat.claudeMode.label")}
      </div>
    </Menu>
  );
}
