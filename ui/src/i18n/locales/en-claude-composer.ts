import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

// Fork: Claude Code parity in the chat composer: Claude CLI's own `/` commands (F51) and the
// status line under the composer (F48).
const catalog = {
  chat: {
    commands: {
      claudeGroup: "Claude Code",
      claudeDescription: "Claude Code command",
      claudeSkillDescription: "Claude Code skill",
    },
    composerStatus: {
      label: "Session status",
      model: "Model: {model}",
      context: "ctx {pct}%",
      contextTitle: "Context used: {detail} ({pct}%)",
      turn: "turn {elapsed}",
      turnTitle: "Current turn running for {elapsed}",
      fiveHour: "5h {percent}%",
      fiveHourTitle: "Claude 5-hour limit: {percent}% used",
      fiveHourReset: "Claude 5-hour limit: {percent}% used, resets in {countdown}",
      limitReached: "5h limit reached",
      permission: "Permissions: {mode}",
    },
  },
} satisfies TranslationMap;

export const registerClaudeComposerEnglish = Object.assign(
  () => {
    Object.assign(en.chat.commands as Record<string, unknown>, catalog.chat.commands);
    (en.chat as Record<string, unknown>).composerStatus = catalog.chat.composerStatus;
  },
  { catalog },
);
