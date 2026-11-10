// Fork (F49): composer picker for the Claude Code permission mode of claude-cli sessions.
import type { GatewaySessionRow } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import { registerClaudeComposerEnglish } from "../../i18n/locales/en-claude-composer.ts";
import type { SessionMethodAccess } from "../../lib/session-method-access.ts";
import type { SessionPatch } from "../../lib/sessions/index.ts";
import { patchChatSessionSettings } from "./chat-settings-patches.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import {
  isClaudeCliSessionRow,
  readClaudePermissionMode,
  type ChatClaudeModePickerProps,
} from "./components/chat-claude-mode.ts";

registerClaudeComposerEnglish();

const pendingClaudeModes = new WeakMap<
  ChatPageHost,
  Map<string, ChatClaudeModePickerProps["mode"] | null>
>();

export function buildChatClaudeModePicker(params: {
  state: ChatPageHost;
  selectedSession: GatewaySessionRow | undefined;
  sessionKey: string;
  agentId?: string;
  expectedSessionId?: string;
  /** Same access as the OpenClaw permission picker: sessions.patch with operator.write. */
  access: SessionMethodAccess;
  canSelectBypass: boolean;
  canPatch: (patch: SessionPatch) => boolean;
  ownsSelection: () => boolean;
}): ChatClaudeModePickerProps | undefined {
  const { state, selectedSession, sessionKey } = params;
  if (!isClaudeCliSessionRow(selectedSession)) {
    return undefined;
  }
  const scopeKey = JSON.stringify([sessionKey, params.agentId, params.expectedSessionId]);
  const pending = pendingClaudeModes.get(state) ?? new Map();
  pendingClaudeModes.set(state, pending);
  const stored = readClaudePermissionMode(selectedSession?.claudePermissionMode);
  const pendingMode = pending.get(scopeKey);
  return {
    mode: pending.has(scopeKey) ? (pendingMode ?? undefined) : stored,
    canSelectBypass: params.canSelectBypass,
    disabled: !params.access.allowed,
    disabledReason: params.access.allowed ? undefined : params.access.reason,
    pending: pending.has(scopeKey),
    onSelect: async (mode) => {
      const patch: SessionPatch = { claudePermissionMode: mode };
      if (!params.access.allowed || pending.has(scopeKey) || !params.canPatch(patch)) {
        return;
      }
      // Show the chosen mode while the write and the list refresh settle.
      pending.set(scopeKey, mode);
      state.requestUpdate?.();
      try {
        state.chatError = state.lastError = null;
        const patched = await patchChatSessionSettings(state, sessionKey, patch, {
          ...(params.agentId ? { agentId: params.agentId } : {}),
          expectedSessionId: params.expectedSessionId,
          canDispatch: () => params.canPatch(patch),
        });
        if (!patched) {
          throw new Error("Session capability is unavailable");
        }
      } catch (error) {
        if (params.ownsSelection()) {
          state.chatError = state.lastError = t("chat.claudeMode.updateFailed", {
            error: String(error),
          });
        }
      } finally {
        pending.delete(scopeKey);
        state.requestUpdate?.();
      }
    },
  };
}
