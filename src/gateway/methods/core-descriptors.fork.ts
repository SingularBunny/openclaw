import type { CoreGatewayMethodSpecRow } from "./core-descriptor-types.js";

// Fork: core gateway methods the ai-workbench fork adds, appended to the canonical table in
// core-descriptors.ts (kept here so that table stays within its size limit).
export const FORK_GATEWAY_METHOD_SPECS = [
  // Fork (F47): stop one Claude CLI background task of the session.
  ["sessions.cliTasks.stop", "sessions-cli-tasks", "operator.write", "2026.10"],
  // Fork (F52): files a Claude CLI rewind would restore (dry run); admin like sessions.rewind.
  ["sessions.rewind.files", "sessions-rewind", "operator.admin", "2026.10"],
  ["commands.claude", "commands", "operator.read", "2026.10"],
  // Fork (I14): hand a refused reply off; logs and leaves the refused turn out of model context.
  ["chat.refusal.handoff", "chat-refusal", "operator.write", "2026.10"],
] as const satisfies readonly CoreGatewayMethodSpecRow[];
