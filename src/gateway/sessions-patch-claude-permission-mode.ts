import type { SessionsPatchParams } from "../../packages/gateway-protocol/src/index.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions/types.js";
import {
  CLAUDE_PERMISSION_MODES,
  normalizeClaudePermissionMode,
} from "../shared/claude-permission-mode.js";

/**
 * Fork (F49): Claude CLI permission mode; the CLI runtime applies it on the next turn.
 * Null clears the stored mode; an unknown mode returns the error text.
 */
export function applySessionsPatchClaudePermissionMode(params: {
  patch: SessionsPatchParams;
  next: SessionEntry;
}): string | undefined {
  const raw = params.patch.claudePermissionMode;
  if (raw === null) {
    delete params.next.claudePermissionMode;
  } else if (raw !== undefined) {
    const value = normalizeClaudePermissionMode(raw);
    if (value === undefined) {
      return `invalid claudePermissionMode (use ${CLAUDE_PERMISSION_MODES.join("|")})`;
    }
    params.next.claudePermissionMode = value;
  }
  return undefined;
}
