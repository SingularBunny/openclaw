// Fork: composer toggle of a chat bound to an ACP agent: Ask (each permission request is a
// question) or Allow all (the bound ACP session stops asking; decisions are still asked).
import { Icon } from "../../../components/solid/icon.tsx";
import { t } from "../../../lib/reactive/i18n.ts";
import type { ChatAcpPermissionToggleProps } from "../chat-acp-permissions.ts";

export function ChatAcpPermissionToggle(props: ChatAcpPermissionToggleProps) {
  const allowAll = () => props.mode === "allow-all";
  return (
    <button
      type="button"
      class={[
        "chat-controls__inline-select-trigger chat-controls__acp-permission-toggle",
        { "chat-controls__acp-permission-toggle--allow-all": allowAll() },
      ]}
      aria-pressed={allowAll() ? "true" : "false"}
      aria-busy={props.pending ? "true" : undefined}
      aria-label={`${t("chat.acpPermissions.label")}: ${
        allowAll() ? t("chat.acpPermissions.allowAll") : t("chat.acpPermissions.ask")
      }`}
      title={t(allowAll() ? "chat.acpPermissions.allowAllTitle" : "chat.acpPermissions.askTitle", {
        agent: props.agent,
      })}
      data-chat-acp-permissions={props.mode}
      disabled={props.disabled || props.pending}
      onClick={() => void props.onSelect(allowAll() ? "ask" : "allow-all")}
    >
      <span class="chat-controls__permission-icon" aria-hidden="true">
        <Icon name={allowAll() ? "shieldAlert" : "hand"} />
      </span>
      <span class="chat-controls__claude-mode-text">
        {allowAll() ? t("chat.acpPermissions.allowAll") : t("chat.acpPermissions.ask")}
      </span>
    </button>
  );
}
