import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { UiSettings } from "../../app/settings-contract.ts";
import { areUiSessionKeysEquivalent } from "../../lib/sessions/session-key.ts";
import { normalizeChatBubbleSessionKeys } from "./chat-bubble-mode.ts";

// Fork: "Show automation details" — a browser-local default in Settings plus a
// per-chat override from the chat's View menu. Off keeps one bare line per run.

type AutomationDetailsSettings = Pick<
  UiSettings,
  | "chatShowAutomationDetails"
  | "chatAutomationDetailsSessionKeys"
  | "chatAutomationDetailsHiddenSessionKeys"
>;

/** Normalizes the stored record; only non-default values survive. */
export function parseAutomationDetailsSettings(value: unknown): AutomationDetailsSettings {
  const record = asOptionalRecord(value) ?? {};
  return {
    chatShowAutomationDetails: record.chatShowAutomationDetails === true ? true : undefined,
    chatAutomationDetailsSessionKeys: normalizeChatBubbleSessionKeys(
      record.chatAutomationDetailsSessionKeys,
    ),
    chatAutomationDetailsHiddenSessionKeys: normalizeChatBubbleSessionKeys(
      record.chatAutomationDetailsHiddenSessionKeys,
    ),
  };
}

export function isAutomationDetailsShown(
  settings: AutomationDetailsSettings,
  sessionKey: string,
): boolean {
  const includes = (keys: string[] | undefined) =>
    keys?.some((key) => areUiSessionKeysEquivalent(key, sessionKey)) === true;
  if (includes(settings.chatAutomationDetailsHiddenSessionKeys)) {
    return false;
  }
  return (
    includes(settings.chatAutomationDetailsSessionKeys) ||
    settings.chatShowAutomationDetails === true
  );
}

/** Per-chat override; a value equal to the default clears the override. */
export function setAutomationDetailsShown(
  settings: AutomationDetailsSettings,
  sessionKey: string,
  shown: boolean,
): Partial<UiSettings> {
  const key = sessionKey.trim();
  if (!key) {
    return {};
  }
  const without = (keys: string[] | undefined) =>
    (normalizeChatBubbleSessionKeys(keys) ?? []).filter(
      (candidate) => !areUiSessionKeysEquivalent(candidate, key),
    );
  const on = without(settings.chatAutomationDetailsSessionKeys);
  const off = without(settings.chatAutomationDetailsHiddenSessionKeys);
  if (shown !== (settings.chatShowAutomationDetails === true)) {
    (shown ? on : off).push(key);
  }
  return {
    chatAutomationDetailsSessionKeys: on.length > 0 ? on : undefined,
    chatAutomationDetailsHiddenSessionKeys: off.length > 0 ? off : undefined,
  };
}
