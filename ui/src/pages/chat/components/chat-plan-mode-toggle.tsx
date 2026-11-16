// Fork: the Plan toggle in the composer, next to the permission and Claude Code mode pickers. It
// flips the workbench plan mode of this chat (the same state as `/plan` and `/plan off`) for any model.
import { Show } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { registerModelControlsEnglish } from "../../../i18n/locales/en-model-controls.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import type { ChatPlanModeToggleProps } from "./chat-plan-mode-toggle.types.ts";

registerEnglishCatalog(registerModelControlsEnglish);

export function ChatPlanModeToggle(props: ChatPlanModeToggleProps) {
  const blocked = () => Boolean(props.disabled || props.pending);
  const title = () =>
    props.disabledReason ?? (props.on ? t("chat.planMode.turnOff") : t("chat.planMode.turnOn"));
  return (
    <button
      type="button"
      class={[
        "chat-controls__inline-select-trigger chat-controls__plan-mode-toggle",
        {
          "chat-controls__plan-mode-toggle--on": props.on,
          "chat-controls__inline-select-trigger--disabled": props.disabled,
        },
      ]}
      data-chat-plan-mode-toggle="true"
      data-chat-plan-mode={props.on ? "on" : "off"}
      aria-pressed={props.on ? "true" : "false"}
      aria-label={t("chat.planMode.label")}
      aria-busy={props.pending ? "true" : "false"}
      title={title()}
      disabled={blocked()}
      onClick={() => {
        if (!blocked()) {
          void props.onToggle(!props.on);
        }
      }}
    >
      <span class="chat-controls__permission-icon" aria-hidden="true">
        <Icon name="listChecks" />
      </span>
      <Show when={props.on}>
        <span class="chat-controls__plan-mode-text">{t("chat.planMode.on")}</span>
      </Show>
    </button>
  );
}
