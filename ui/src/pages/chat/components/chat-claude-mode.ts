// Fork (F49): Claude Code permission modes for `claude-cli` sessions (session.claudePermissionMode).
import type { ClaudePermissionMode } from "../../../../../packages/gateway-protocol/src/index.js";
import { resolveModelRuntimeRoute } from "../../../../../src/shared/model-runtime-route.js";
import type { GatewaySessionRow } from "../../../api/types.ts";
import type { IconName } from "../../../components/icon-data.ts";

export type { ClaudePermissionMode };

export const CLAUDE_MODES = [
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
  "dontAsk",
  "auto",
] as const satisfies readonly ClaudePermissionMode[];

export const CLAUDE_MODE_ICONS: Record<ClaudePermissionMode, IconName> = {
  default: "hand",
  acceptEdits: "penLine",
  plan: "pause",
  bypassPermissions: "shieldAlert",
  dontAsk: "lock",
  auto: "wandSparkles",
};

export type ChatClaudeModePickerProps = {
  /** Explicit session mode; undefined keeps the runtime's established behavior. */
  mode?: ClaudePermissionMode;
  /** bypassPermissions needs operator.admin, like the OpenClaw "full" mode. */
  canSelectBypass: boolean;
  disabled?: boolean;
  disabledReason?: string;
  pending?: boolean;
  onSelect: (mode: ClaudePermissionMode | null) => unknown;
};

export function readClaudePermissionMode(raw: unknown): ClaudePermissionMode | undefined {
  return CLAUDE_MODES.find((mode) => mode === raw);
}

/** The picker belongs to sessions that run through the Claude CLI backend. */
export function isClaudeCliSessionRow(row: GatewaySessionRow | undefined): boolean {
  if (!row) {
    return false;
  }
  const runtime = row.agentRuntime?.id?.trim();
  return (
    resolveModelRuntimeRoute(row.modelProvider?.trim() ?? "", runtime || undefined) === "claudeCli"
  );
}
