// Fork (F47, F49, F52): the warm Claude CLI session's mode gates, prompt predictions, task stop
// and file rewind, kept out of cli.runtime.ts. Session and turn are typed by what they use here.
import { randomUUID } from "node:crypto";
import type {
  CliBackendExecuteContext,
  CliBackendLiveSessionHandle,
  CliBackendToolPermissionResult,
} from "openclaw/plugin-sdk/cli-backend";
import {
  applyPendingPermissionMode,
  settlePermissionModeAtTurnStart,
  switchPermissionMode,
  type ClaudeCliPendingPermissionMode,
} from "./cli-permission-mode-sync.js";
import {
  createClaudeCliPlanApprover,
  resolveClaudeCliModeGate,
  type ClaudeCliPermissionMode,
} from "./cli-permission-mode.js";
import { isClaudeCliPlanFileEdit } from "./cli-plan-file.js";
import { CLAUDE_CLI_INPUT_UUID_FIELD, requestClaudeCliRewindFiles } from "./cli-rewind-files.js";

type ForkTransport = Parameters<typeof requestClaudeCliRewindFiles>[0] & {
  send(message: Record<string, unknown>): Promise<void>;
};

type ForkSession = {
  closed: boolean;
  transport?: ForkTransport;
  permissionMode: ClaudeCliPermissionMode;
  pendingPermissionMode?: ClaudeCliPendingPermissionMode;
  reportPromptSuggestion?: (text: string) => void;
  taskOwners: Map<string, string | false>;
  currentTurn?: { inputUuid: string };
};

type ForkTurn = {
  context: Pick<CliBackendExecuteContext, "cwd" | "env" | "onPermissionModeChange">;
  permissionMode?: ClaudeCliPermissionMode;
  planApprover: ReturnType<typeof createClaudeCliPlanApprover>;
};

/**
 * Plan approval card for ExitPlanMode in plan mode (or one the hook already decided). Returns
 * undefined for every other tool call, which the session mode gate then checks.
 */
export async function approveClaudeCliPlanExit(
  session: ForkSession,
  turn: ForkTurn,
  call: { toolName: string; input: Record<string, unknown>; toolUseId?: string },
  signal: AbortSignal,
  isCurrent: () => boolean,
): Promise<CliBackendToolPermissionResult | undefined> {
  const { toolName, input, toolUseId } = call;
  if (
    toolName !== "ExitPlanMode" ||
    (turn.permissionMode !== "plan" && !turn.planApprover.has(toolUseId))
  ) {
    return undefined;
  }
  const planned = await turn.planApprover.approve({ input, signal, toolUseId });
  if (!isCurrent() || signal.aborted) {
    return { behavior: "deny", message: "The OpenClaw run is no longer active." };
  }
  if (planned.mode) {
    // Native validates ExitPlanMode against its own mode after this decision; switching now
    // fails the tool with "You are not in plan mode". The switch follows the tool result.
    await switchPermissionMode(session, turn, planned.mode, toolUseId ?? null);
  }
  return planned.result;
}

/** The session mode's verdict on a native tool call, on top of host policy. */
export async function resolveClaudeCliToolModeGate(
  turn: ForkTurn,
  toolName: string,
  input: Record<string, unknown>,
  cwd: unknown,
) {
  return resolveClaudeCliModeGate(turn.permissionMode, toolName, {
    planFileEdit:
      turn.permissionMode === "plan" &&
      (await isClaudeCliPlanFileEdit({
        toolName,
        input,
        cwd: typeof cwd === "string" ? cwd : turn.context.cwd,
        env: turn.context.env,
      })),
  });
}

/** The native EnterPlanMode tool enters plan mode itself; keep the host gate and the session in step. */
export async function followClaudeCliEnterPlanMode(
  session: ForkSession,
  turn: ForkTurn,
  toolName: string,
  decision: CliBackendToolPermissionResult,
): Promise<void> {
  if (
    decision.behavior === "allow" &&
    toolName === "EnterPlanMode" &&
    turn.permissionMode &&
    turn.permissionMode !== "plan"
  ) {
    session.permissionMode = "plan";
    await switchPermissionMode(session, turn, "plan");
  }
}

/** Fork (C10, F49): plan mode refuses OpenClaw's edit tools as it refuses native edits. */
export function openClawToolHookResponse(
  mode: ClaudeCliPermissionMode | undefined,
  toolName: string,
) {
  const gate = resolveClaudeCliModeGate(mode, toolName);
  return gate.kind === "deny"
    ? {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: gate.message,
        },
      }
    : { continue: true };
}

/**
 * Prepares a received record for the session: the result names the turn's input uuid (Claude's
 * file checkpoint key, F52) and a pending mode switch follows its tool result. A next-prompt
 * prediction is consumed here and returns undefined.
 */
export function receiveClaudeCliForkMessage(
  session: ForkSession,
  received: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const message =
    received.type === "result" && session.currentTurn
      ? { ...received, [CLAUDE_CLI_INPUT_UUID_FIELD]: session.currentTurn.inputUuid }
      : received;
  applyPendingPermissionMode(session, message);
  if (message.type !== "prompt_suggestion") {
    return message;
  }
  // A forked side request predicts the next prompt after the result. It is never turn
  // output, and once another turn has started the prediction is stale.
  if (!session.currentTurn && typeof message.suggestion === "string") {
    try {
      session.reportPromptSuggestion?.(message.suggestion);
    } catch {
      // Presentation only; a failed sink must not close the warm process.
    }
  }
  return undefined;
}

/** A warm process follows the session's mode chosen since its last turn; a new one starts in it. */
export async function startClaudeCliTurnPermissionMode(
  session: ForkSession,
  turn: ForkTurn,
  warm: boolean,
): Promise<void> {
  if (warm) {
    await settlePermissionModeAtTurnStart(session, turn.permissionMode ?? "default");
  } else {
    session.permissionMode = turn.permissionMode ?? "default";
  }
}

/**
 * Live session handle methods the fork adds: stop one background task, rewind files. The session
 * is read when a method runs, since the handle is built inside the session itself.
 */
export function claudeCliForkHandleMethods(
  readSession: () => ForkSession,
): Pick<CliBackendLiveSessionHandle, "stopTask" | "rewindFiles"> {
  return {
    // Fork (F47): the CLI answers with task_notification status "stopped".
    stopTask: async (taskId) => {
      const session = readSession();
      const transport = session.transport;
      if (session.closed || !transport || !session.taskOwners.has(taskId)) {
        return false;
      }
      await transport.send({
        type: "control_request",
        request_id: `stop_task_${randomUUID()}`,
        request: { subtype: "stop_task", task_id: taskId },
      });
      return true;
    },
    // Fork (F52): only an idle process may restore files; a running turn could still edit.
    rewindFiles: async (userMessageId, { dryRun }) => {
      const session = readSession();
      const transport = session.transport;
      if (session.closed || !transport || session.currentTurn) {
        return undefined;
      }
      return await requestClaudeCliRewindFiles(transport, userMessageId, dryRun);
    },
  };
}
