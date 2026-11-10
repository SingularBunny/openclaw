// Fork (F49): keeps a warm Claude CLI process, the running turn, and the session in one mode.
import { randomUUID } from "node:crypto";
import type { CliBackendExecuteContext } from "openclaw/plugin-sdk/cli-backend";
import {
  createSetPermissionModeRequest,
  type ClaudeCliPermissionMode,
} from "./cli-permission-mode.js";

/** A switch that waits for a tool result; with no id, for the next one. */
export type ClaudeCliPendingPermissionMode = {
  mode: ClaudeCliPermissionMode;
  toolUseId?: string;
};

type ModeSession = {
  closed: boolean;
  transport?: { send(message: Record<string, unknown>): Promise<void> };
  /** The mode the native process was launched with or last switched to. */
  permissionMode: ClaudeCliPermissionMode;
  pendingPermissionMode?: ClaudeCliPendingPermissionMode;
};

type ModeTurn = {
  context: Pick<CliBackendExecuteContext, "onPermissionModeChange">;
  permissionMode?: ClaudeCliPermissionMode;
};

function syncPermissionMode(session: ModeSession, mode: ClaudeCliPermissionMode): Promise<void> {
  const transport = session.transport;
  if (session.closed || !transport) {
    return Promise.resolve();
  }
  session.permissionMode = mode;
  // Like stop_task, the control response carries nothing the turn waits for.
  return transport.send(createSetPermissionModeRequest(mode, randomUUID())).catch(() => {});
}

/**
 * Applies a mode to the rest of the turn, the native process, and the session.
 * `afterToolUseId` defers the native switch until that tool's result (null: the next result).
 */
export async function switchPermissionMode(
  session: ModeSession,
  turn: ModeTurn,
  mode: ClaudeCliPermissionMode,
  afterToolUseId?: string | null,
): Promise<void> {
  // The hook and can_use_tool can both carry one ExitPlanMode decision.
  if (turn.permissionMode === mode) {
    return;
  }
  turn.permissionMode = mode;
  if (afterToolUseId !== undefined) {
    session.pendingPermissionMode = {
      mode,
      ...(afterToolUseId ? { toolUseId: afterToolUseId } : {}),
    };
  } else if (session.permissionMode !== mode) {
    void syncPermissionMode(session, mode);
  }
  await turn.context.onPermissionModeChange?.(mode);
}

/** A native user record carrying a tool result: for `toolUseId`, or any when it is unknown. */
export function isToolResultFor(message: Record<string, unknown>, toolUseId?: string): boolean {
  const inner = message.message;
  const content =
    message.type === "user" && inner && typeof inner === "object"
      ? (inner as { content?: unknown }).content
      : undefined;
  return (
    Array.isArray(content) &&
    content.some(
      (block) =>
        block !== null &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "tool_result" &&
        (toolUseId === undefined || (block as { tool_use_id?: unknown }).tool_use_id === toolUseId),
    )
  );
}

/** After the approved ExitPlanMode has run (and left plan mode itself), applies the choice. */
export function applyPendingPermissionMode(
  session: ModeSession,
  message: Record<string, unknown>,
): void {
  const pending = session.pendingPermissionMode;
  if (pending && isToolResultFor(message, pending.toolUseId)) {
    session.pendingPermissionMode = undefined;
    void syncPermissionMode(session, pending.mode);
  }
}

/**
 * Before a warm process takes the next prompt: switch to the turn's mode. The request is written
 * ahead of the prompt on the same stdin, so native reads it first. A switch still waiting for its
 * tool result leaves the native mode unknown, so it is restated.
 */
export async function settlePermissionModeAtTurnStart(
  session: ModeSession,
  mode: ClaudeCliPermissionMode,
): Promise<void> {
  const unsettled = session.pendingPermissionMode !== undefined;
  session.pendingPermissionMode = undefined;
  if (unsettled || session.permissionMode !== mode) {
    await syncPermissionMode(session, mode);
  }
}
