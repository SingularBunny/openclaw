import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

// Fork: the app-level notice of a Gateway restart that waits for running work.
const catalog = {
  common: {
    gatewayRestart: {
      pending: "Gateway restart pending: {waiting}, restarts {when} (reason: {reason})",
      waitingTurn: "waiting for 1 running turn",
      waitingTurns: "waiting for {count} running turns",
      waitingWork: "waiting for {count} background tasks",
      waitingNothing: "finishing up",
      atMostIn: "at most in {minutes} min",
      whenTurnsFinish: "when they finish",
      restarting: "Gateway restarting now…",
      restarted: "Gateway restarted",
      dismiss: "Dismiss",
    },
  },
} satisfies TranslationMap;

export const registerGatewayRestartEnglish = Object.assign(
  () => {
    Object.assign(en.common as Record<string, unknown>, catalog.common);
  },
  { catalog },
);
