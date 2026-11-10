// Fork (F49): Claude Code's own permission modes for `claude-cli` sessions.
import type { ClaudePermissionMode } from "../../packages/gateway-protocol/src/schema/sessions-row.js";

export type { ClaudePermissionMode };

/** Modes accepted by `claude --permission-mode` (Claude Agent SDK `PermissionMode`). */
export const CLAUDE_PERMISSION_MODES = [
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
  "dontAsk",
  "auto",
] as const satisfies readonly ClaudePermissionMode[];

/** Exact wire values only; aliases such as "manual" stay invalid on the session record. */
export function normalizeClaudePermissionMode(raw: unknown): ClaudePermissionMode | undefined {
  return typeof raw === "string"
    ? CLAUDE_PERMISSION_MODES.find((mode) => mode === raw.trim())
    : undefined;
}

/** Like the OpenClaw "full" mode, skipping every Claude permission check needs an administrator. */
export function isClaudePermissionModeAdminOnly(raw: unknown): boolean {
  return raw === "bypassPermissions";
}
