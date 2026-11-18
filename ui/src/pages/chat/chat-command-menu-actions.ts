// Fork: chat commands as items of the chat's ⋯ menu, so nothing needs typing. "New chat" is `/new`
// (the same new session the composer command opens), "Reset chat…" is `/reset` after a
// confirmation, and "Learn a skill from this chat" is `/learn`. The commands stay as a fallback;
// each item runs exactly what its command runs, for any model.
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import { i18n, t } from "../../i18n/index.ts";
import { registerModelControlsEnglish } from "../../i18n/locales/en-model-controls.ts";
import { readSessionMethodAccess } from "../../lib/session-method-access.ts";
import { ChatPaneHeaderMemo } from "./chat-pane-header-memo.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import type { HeaderMenuSessionAction } from "./components/chat-quick-action.tsx";

registerModelControlsEnglish();

export type ChatCommandMenuHost = Pick<
  ChatPageHost,
  "client" | "hello" | "connected" | "sessionKey" | "handleSendChat" | "createChatSession"
>;

export type ChatCommandMenuDeps = {
  confirm: (options: {
    title: string;
    message: string;
    confirmLabel: string;
    danger: boolean;
  }) => Promise<boolean>;
};

function gatewaySnapshot(host: ChatCommandMenuHost) {
  return {
    client: host.client ?? null,
    hello: host.hello ?? null,
    phase: host.connected ? ("connected" as const) : ("offline" as const),
  };
}

/** Why a command item is unavailable, or undefined when it can run. */
export function chatCommandDisabledReason(
  host: ChatCommandMenuHost,
  command: "new" | "reset" | "learn",
): string | undefined {
  if (!host.client || !host.connected) {
    return t("chat.commandMenu.offline");
  }
  if (command === "new") {
    return host.createChatSession ? undefined : t("chat.commandMenu.newUnavailable");
  }
  // As typed: /learn needs chat.send; /reset needs it with operator.admin (resets are admin-only).
  const access = readSessionMethodAccess(gatewaySnapshot(host), {
    method: "chat.send",
    requiredScope: command === "reset" ? "operator.admin" : "operator.write",
  });
  return access.allowed ? undefined : access.reason;
}

/** Runs one command item; resolves whether its command was sent. */
export async function runChatMenuCommand(
  host: ChatCommandMenuHost,
  command: "new" | "reset" | "learn",
  deps: ChatCommandMenuDeps,
): Promise<boolean> {
  if (chatCommandDisabledReason(host, command)) {
    return false;
  }
  if (command === "new") {
    return Boolean(await host.createChatSession?.());
  }
  if (command === "reset") {
    const sessionKey = host.sessionKey;
    const confirmed = await deps.confirm({
      title: t("chat.commandMenu.resetConfirmTitle"),
      message: t("chat.commandMenu.resetConfirmMessage"),
      confirmLabel: t("chat.commandMenu.resetConfirm"),
      danger: true,
    });
    // The chat on screen may have changed while the dialog was open.
    if (!confirmed || host.sessionKey !== sessionKey) {
      return false;
    }
    await host.handleSendChat("/reset");
    return true;
  }
  await host.handleSendChat("/learn");
  return true;
}

const NO_ACTIONS: HeaderMenuSessionAction[] = [];

export class ChatCommandMenuActions {
  private readonly memo = new ChatPaneHeaderMemo<HeaderMenuSessionAction[]>();

  /** The command items, followed by the menu's other quick actions (`others`). */
  read(
    host: ChatCommandMenuHost | undefined,
    others: HeaderMenuSessionAction[] = NO_ACTIONS,
    deps: ChatCommandMenuDeps = { confirm: (options) => showConfirmDialog(options) },
  ): HeaderMenuSessionAction[] {
    if (!host) {
      return others;
    }
    const reasons = {
      new: chatCommandDisabledReason(host, "new"),
      reset: chatCommandDisabledReason(host, "reset"),
      learn: chatCommandDisabledReason(host, "learn"),
    };
    return this.memo.read(
      [host, host.sessionKey, reasons.new, reasons.reset, reasons.learn, i18n.getLocale(), others],
      () => [
        {
          id: "command-new",
          label: t("chat.commandMenu.new"),
          description: reasons.new,
          icon: "messageSquarePlus",
          disabled: Boolean(reasons.new),
          onActivate: () => void runChatMenuCommand(host, "new", deps),
        },
        {
          id: "command-learn",
          label: t("chat.commandMenu.learn"),
          description: reasons.learn ?? t("chat.commandMenu.learnDescription"),
          icon: "pencilSparkles",
          disabled: Boolean(reasons.learn),
          onActivate: () => void runChatMenuCommand(host, "learn", deps),
        },
        {
          id: "command-reset",
          label: t("chat.commandMenu.reset"),
          description: reasons.reset,
          icon: "repeat",
          variant: "danger" as const,
          disabled: Boolean(reasons.reset),
          onActivate: () => void runChatMenuCommand(host, "reset", deps),
        },
        ...others,
      ],
    );
  }
}
