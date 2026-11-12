// Fork (F52, V1): the "also restore files" option of the rewind confirmation (any model).
import { t } from "../../lib/reactive/i18n.ts";
import { scopedAgentParamsForSession } from "../../lib/sessions/index.ts";
import { resolveChatMessageCutTarget } from "./chat-rewind-target.ts";
import type { ChatState } from "./chat-state-contract.ts";

/** What the operator chose in the rewind confirmation. */
export type ChatRewindChoice = { restoreFiles: boolean };

/** `sessions.rewind.files`: what a rewind before one message would restore. */
export type ChatRewindFilesPreview = {
  available: boolean;
  reason?: string;
  files?: string[];
  insertions?: number;
  deletions?: number;
};

export type ChatRewindFilesProvider = () => Promise<ChatRewindFilesPreview | null>;

const LISTED_FILES = 8;

/** Asks the Gateway which files Claude would restore; null when the check is not possible. */
export async function previewChatRewindFiles(
  state: Pick<ChatState, "client" | "connected" | "sessionKey" | "chatMessages"> &
    Parameters<typeof scopedAgentParamsForSession>[0],
  entryId: string,
): Promise<ChatRewindFilesPreview | null> {
  const client = state.client;
  const target = resolveChatMessageCutTarget(state.chatMessages, entryId);
  if (!client || !state.connected || !target) {
    return null;
  }
  const { agentId } = scopedAgentParamsForSession(state, state.sessionKey);
  try {
    return await client.request<ChatRewindFilesPreview>("sessions.rewind.files", {
      sessionKey: state.sessionKey,
      ...(agentId ? { agentId } : {}),
      ...target,
    });
  } catch {
    return null;
  }
}

function fileName(path: string): string {
  return path.split(/[\\/]/u).findLast(Boolean) ?? path;
}

/**
 * Fills the confirmation's files section from the preview and returns its checkbox, if the
 * files can be restored. Claude Code's own /rewind focuses "Restore code and conversation"
 * whenever code can be restored, so the option starts checked.
 */
export function renderChatRewindFilesSection(
  section: HTMLElement,
  preview: ChatRewindFilesPreview | null,
): HTMLInputElement | null {
  section.replaceChildren();
  if (!preview) {
    section.hidden = true;
    return null;
  }
  section.hidden = false;
  const note = (text: string) => {
    const line = document.createElement("p");
    line.className = "chat-confirm-popover__files-note";
    line.textContent = text;
    section.append(line);
  };
  const files = preview.files ?? [];
  if (!preview.available) {
    note(
      t("chat.messages.rewindFilesUnavailable", {
        reason: preview.reason ?? t("chat.messages.rewindFilesUnknownReason"),
      }),
    );
    return null;
  }
  if (files.length === 0) {
    note(t("chat.messages.rewindFilesNone"));
    return null;
  }
  const label = document.createElement("label");
  label.className = "chat-confirm-popover__remember chat-confirm-popover__files-option";
  const check = document.createElement("input");
  check.type = "checkbox";
  check.className = "chat-confirm-popover__check chat-confirm-popover__files-check";
  check.checked = true;
  const text = document.createElement("span");
  text.textContent =
    files.length === 1
      ? t("chat.messages.rewindFilesRestoreOne")
      : t("chat.messages.rewindFilesRestore", { count: String(files.length) });
  label.append(check, text);
  section.append(label);
  const list = document.createElement("ul");
  list.className = "chat-confirm-popover__files-list";
  for (const path of files.slice(0, LISTED_FILES)) {
    const item = document.createElement("li");
    item.textContent = fileName(path);
    item.title = path;
    list.append(item);
  }
  if (files.length > LISTED_FILES) {
    const more = document.createElement("li");
    more.textContent = t("chat.messages.rewindFilesMore", {
      count: String(files.length - LISTED_FILES),
    });
    list.append(more);
  }
  section.append(list);
  if (preview.insertions !== undefined || preview.deletions !== undefined) {
    note(
      t("chat.messages.rewindFilesLines", {
        insertions: String(preview.insertions ?? 0),
        deletions: String(preview.deletions ?? 0),
      }),
    );
  }
  return check;
}
