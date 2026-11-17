import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

// Fork: maintenance mode (chats paused while OpenClaw is updated or on demand).
const catalog = {
  common: {
    gatewayMaintenance: {
      status: "Maintenance: chats paused",
      banner:
        "Maintenance: chats paused ({reason}, since {since}). Messages you send wait and go out when it ends.",
      bannerBy:
        "Maintenance: chats paused ({reason}, since {since}, by {source}). Messages you send wait and go out when it ends.",
      resume: "Resume chats",
      resuming: "Resuming…",
      pause: "Pause chats (maintenance)",
      pauseHint:
        "No new chat turn starts until you resume: messages wait, automations are deferred. Settings and plugins stay editable.",
      failed: "Could not change maintenance mode: {error}",
      sendWaiting:
        "Chats are paused for maintenance. The message waits and sends itself when maintenance ends.",
      installerHint: "An install or update is running; it resumes chats when it finishes.",
    },
  },
  connection: {
    maintenance: "Maintenance: chats paused",
  },
} satisfies TranslationMap;

export const registerGatewayMaintenanceEnglish = Object.assign(
  () => {
    Object.assign(en.common as Record<string, unknown>, catalog.common);
    Object.assign(en.connection as Record<string, unknown>, catalog.connection);
  },
  { catalog },
);
