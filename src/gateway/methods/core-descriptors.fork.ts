import type { CoreGatewayMethodSpecRow } from "./core-descriptor-types.js";
import { CORE_GATEWAY_METHOD_SPECS as UPSTREAM_CORE_GATEWAY_METHOD_SPECS } from "./core-descriptors.js";

// Fork: core gateway methods the ai-workbench fork adds, appended to the canonical table in
// core-descriptors.ts (kept here so that table stays within its size limit).
export const FORK_GATEWAY_METHOD_SPECS = [
  ["sessions.catalog.reorder", "session-catalog", "operator.write", "2026.10"],
  ["sessions.catalog.move", "session-catalog", "operator.write", "2026.10"],
  ["canvas.storage.get", "canvas", "operator.read", "2026.10"],
  ["canvas.storage.list", "canvas", "operator.read", "2026.10"],
  ["canvas.storage.set", "canvas", "operator.write", "2026.10"],
  ["canvas.storage.delete", "canvas", "operator.write", "2026.10"],
  // Fork (F47): stop one Claude CLI background task of the session.
  ["sessions.cliTasks.stop", "sessions-cli-tasks", "operator.write", "2026.10"],
  // Fork (F52): files a Claude CLI rewind would restore (dry run); admin like sessions.rewind.
  ["sessions.rewind.files", "sessions-rewind", "operator.admin", "2026.10"],
  ["commands.claude", "commands", "operator.read", "2026.10"],
  // Fork (I14): hand a refused reply off; logs and leaves the refused turn out of model context.
  ["chat.refusal.handoff", "chat-refusal", "operator.write", "2026.10"],
  // Fork: maintenance mode pauses new chat turns while admin work (config, plugins) stays open.
  ["gateway.maintenance.status", "maintenance-mode", "operator.read", "2026.11"],
  ["gateway.maintenance.enter", "maintenance-mode", "operator.admin", "2026.11"],
  // Exit is the escape hatch and must not sit behind write-rate limiting.
  ["gateway.maintenance.exit", "maintenance-mode", "operator.admin", "2026.11"],
] as const satisfies readonly CoreGatewayMethodSpecRow[];

/** The canonical upstream table followed by the fork's rows; method policy reads this one. */
export const CORE_GATEWAY_METHOD_SPECS = [
  ...UPSTREAM_CORE_GATEWAY_METHOD_SPECS,
  ...FORK_GATEWAY_METHOD_SPECS,
] as const satisfies readonly CoreGatewayMethodSpecRow[];
