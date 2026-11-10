// Fork (F49): the Claude CLI permission mode a run starts in, and the mode an operator picks
// while approving a plan, stored on the session entry like any other session setting.
import { patchSessionEntryCore } from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { emitSessionLifecycleEvent } from "../../sessions/session-lifecycle-events.js";
import { normalizeClaudePermissionMode } from "../../shared/claude-permission-mode.js";

const log = createSubsystemLogger("agents/cli-runner");

type ClaudePermissionModeRun = {
  agentId?: string;
  sessionId: string;
  sessionKey?: string;
  storePath?: string;
  sessionEntry?: Pick<SessionEntry, "claudePermissionMode">;
};

/** Only an explicit session choice reaches the CLI; no choice keeps today's argv and policy. */
export function resolveRunClaudePermissionMode(run: ClaudePermissionModeRun): string | undefined {
  return normalizeClaudePermissionMode(run.sessionEntry?.claudePermissionMode);
}

/** Persists a mode chosen inside a run; a reset or replaced session keeps its own setting. */
export function createClaudePermissionModeRecorder(
  run: ClaudePermissionModeRun,
): ((mode: string) => Promise<void>) | undefined {
  const sessionKey = run.sessionKey;
  if (!sessionKey) {
    return undefined;
  }
  return async (raw) => {
    const mode = normalizeClaudePermissionMode(raw);
    if (!mode) {
      return;
    }
    try {
      const committed = await patchSessionEntryCore(
        {
          ...(run.agentId ? { agentId: run.agentId } : {}),
          sessionKey,
          ...(run.storePath ? { storePath: run.storePath } : {}),
        },
        (entry) => (entry.sessionId === run.sessionId ? { claudePermissionMode: mode } : null),
        { preserveActivity: true, skipMaintenance: true },
      );
      if (committed) {
        emitSessionLifecycleEvent({
          sessionKey,
          ...(run.agentId ? { agentId: run.agentId } : {}),
          reason: "claude-permission-mode",
          scope: "session-entry",
        });
      }
    } catch (error) {
      // The approved plan already continues in the new mode; only the stored default is stale.
      log.warn(`could not store the Claude permission mode: ${String(error)}`);
    }
  };
}
