import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

// Fork: Claude CLI chats whose Claude Code subscription login expired or is missing.
const catalog = {
  common: {
    claudeCliLogin: {
      title: "Claude subscription login expired",
      body: "Claude Code on this Gateway is no longer signed in to your Claude account. Run this command in a terminal on the Gateway host, sign in in the browser it opens, then try again.",
      banner:
        "Claude Code on this Gateway is not signed in to your Claude account: the subscription login expired or is missing. Run claude auth login in a terminal on the Gateway host, then check again in Model Setup.",
      copyCommand: "Copy command",
      openModelSetup: "Open Model Setup",
    },
  },
} satisfies TranslationMap;

export const registerClaudeCliLoginEnglish = Object.assign(
  () => {
    Object.assign(en.common as Record<string, unknown>, catalog.common);
  },
  { catalog },
);
