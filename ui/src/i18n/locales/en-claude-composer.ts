import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

// Fork: Claude Code parity in the chat composer: Claude CLI's own `/` commands (F51) and the
// status line under the composer (F48); Claude Code permission modes and the plan card (F49).
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
    // Fork (F49): Claude Code permission modes of claude-cli sessions.
    claudeMode: {
      label: "Claude Code mode",
      help: "How Claude Code asks before acting in this session, as --permission-mode.",
      bypassRequiresAdmin: "Bypass permissions requires operator admin access.",
      updateFailed: "Could not change the Claude Code mode: {error}",
      modes: {
        unset: {
          label: "Not set",
          description: "Keep the current behavior: OpenClaw's execution policy decides.",
        },
        default: {
          label: "Ask before edits",
          description: "Claude asks before each file edit and shell command.",
        },
        acceptEdits: {
          label: "Accept edits",
          description: "File edits are applied without asking; shell commands still ask.",
        },
        plan: {
          label: "Plan mode",
          description:
            "Claude explores and plans without changing files, then asks you to approve the plan.",
        },
        bypassPermissions: {
          label: "Bypass permissions",
          description:
            "Claude Code's own checks are skipped; OpenClaw's execution policy still applies.",
        },
        dontAsk: {
          label: "Don't ask",
          description: "Claude Code never prompts; tools it has not pre-approved are refused.",
        },
        auto: {
          label: "Auto",
          description:
            "Claude Code's classifier decides; needs a model and CLI version that support it.",
        },
      },
      status: {
        acceptEdits: "accept edits on",
        plan: "plan mode on",
        bypassPermissions: "bypass permissions on",
        dontAsk: "don't ask on",
        auto: "auto mode on",
      },
    },
    planCard: {
      title: "Plan",
      pending: "Waiting for your approval below",
      approved: "Plan approved",
      rejected: "Kept planning",
    },
  },
} satisfies TranslationMap;

export const registerClaudeComposerEnglish = Object.assign(
  () => {
    Object.assign(en.chat.commands as Record<string, unknown>, catalog.chat.commands);
    (en.chat as Record<string, unknown>).composerStatus = catalog.chat.composerStatus;
    (en.chat as Record<string, unknown>).claudeMode = catalog.chat.claudeMode;
    (en.chat as Record<string, unknown>).planCard = catalog.chat.planCard;
  },
  { catalog },
);
