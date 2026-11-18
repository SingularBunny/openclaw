// Events delivered only to session subscribers; the fork adds chat.prompt_suggestion.
export const SESSION_SUBSCRIPTION_EVENTS: ReadonlySet<string> = new Set([
  "agent",
  "chat",
  "chat.side_result",
  "chat.prompt_suggestion",
  "session.observer",
  "session.narration",
  // Mirrors the raw agent tool event (full args/result snapshots) onto
  // session subscribers; omitting it here would hand scoped clients the
  // exact payload the registry gate suppresses on the `agent` event.
  "session.tool",
  "socket.drain",
]);
