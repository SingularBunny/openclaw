// Fork (F33, F36, F45, F49): what the ai-workbench fork adds around a plugin-owned CLI turn,
// kept out of execute-plugin.ts.
import type { ProgressCardStep } from "../../../packages/gateway-protocol/src/schema/progress-card.js";
import {
  createClaudePermissionModeRecorder,
  resolveRunClaudePermissionMode,
} from "./claude-permission-mode.js";
import { createClaudeCliTodoObserver } from "./claude-todos.js";
import {
  hasCliLiveSessionTranscriptChanged,
  restartCliLiveSession,
} from "./cli-live-session-registry.js";
import { cliBackendLog } from "./log.js";
import { createCliModelRequestWatchdogBridge } from "./model-request-watchdog-fork.js";
import { createCliModelRetryStatusObserver } from "./model-retry-status-fork.js";
import { type CliBackgroundTasksState, createCliNativeWaitObserver } from "./native-wait-state.js";
import type { PreparedCliRunContext } from "./types.js";

/** Explicit session mode plus the recorder for modes chosen during the run (F49). */
function claudePermissionModeContext(run: PreparedCliRunContext["params"]) {
  const permissionMode = resolveRunClaudePermissionMode(run);
  const onPermissionModeChange = createClaudePermissionModeRecorder(run);
  return {
    ...(permissionMode ? { permissionMode } : {}),
    ...(onPermissionModeChange ? { onPermissionModeChange } : {}),
  };
}

/** Execute-context fields the fork adds: the prompt prediction sink and the permission mode. */
export function cliForkExecuteContext(
  run: PreparedCliRunContext["params"],
  onPromptSuggestion: ((text: string) => void) | undefined,
) {
  return {
    ...(onPromptSuggestion ? { onPromptSuggestion } : {}),
    ...claudePermissionModeContext(run),
  };
}

/**
 * Stream observers of one turn: silent native waits (model request, background tasks; F33, F36),
 * model request retries shown in the chat (F89) and Claude's todo list as progress-card steps (F45).
 */
export function createCliForkStreamObservers(
  params: {
    env: Readonly<Record<string, string | undefined>> | undefined;
    onBackgroundTasksChange?: (state: CliBackgroundTasksState) => void;
    onTodosChange?: (steps: ProgressCardStep[]) => void;
  },
  run: Pick<
    PreparedCliRunContext["params"],
    "agentId" | "sessionKey" | "sessionId" | "runId" | "diagnosticOwner" | "executionMode"
  >,
) {
  const nativeWait = createCliNativeWaitObserver(params.env, params.onBackgroundTasksChange);
  // 2026.11.5 session watchdog: request waits and retries extend the turn's allowance.
  const modelRequests = createCliModelRequestWatchdogBridge({
    attempt: run.diagnosticOwner?.watchdogAttempt,
    runId: run.runId,
    env: params.env,
  });
  // F89: Claude CLI's own retries of a model request, shown in the chat.
  const modelRetries = createCliModelRetryStatusObserver(run);
  const onTodosChange = params.onTodosChange;
  const todos = onTodosChange
    ? createClaudeCliTodoObserver({
        stateKey: JSON.stringify([run.agentId, run.sessionKey, run.sessionId]),
        onChange: onTodosChange,
      })
    : undefined;
  return {
    modelRequestGraceMs: nativeWait.modelRequestGraceMs,
    observe(value: Record<string, unknown>) {
      nativeWait.observe(value);
      modelRequests.observe(value);
      modelRetries.observe(value);
      todos?.observe(value);
    },
    finish: () => {
      modelRequests.close();
      return nativeWait.finish();
    },
  };
}

/** A terminal `claude --resume` appended turns the idle process never saw; resume afresh. */
export async function restartCliLiveSessionIfTranscriptChanged(
  context: PreparedCliRunContext,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (await hasCliLiveSessionTranscriptChanged(context)) {
    cliBackendLog.info(
      `cli live session restart: provider=${context.backendResolved.id} reason=transcript-changed`,
    );
    await restartCliLiveSession(context, signal);
  }
}
