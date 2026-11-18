import type { PassThrough } from "node:stream";
import type {
  CliBackendExecuteContext,
  CliBackendLiveSessionCapability,
  CliBackendLiveSessionHandle,
} from "openclaw/plugin-sdk/cli-backend";
import type { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { ClaudeCliPendingPermissionMode } from "./cli-permission-mode-sync.js";
import type {
  createClaudeCliPlanApprover,
  ClaudeCliPermissionMode,
} from "./cli-permission-mode.js";
import type { createClaudeCliTransport } from "./cli-transport.js";
import type { createClaudeCliUserInputAuthorizer } from "./cli-user-input.js";

// Session and turn state of cli.runtime.ts; the fork adds permission mode and prompt predictions.

/**
 * Host-internal, like the forwarded auth credential and not part of the plugin SDK: a host
 * whose history owner can change while the run lasts (a native login) passes a check for
 * where saved turn context leaves after startup, the prompt send and the prompt hook answer.
 */
export type ClaudeCliExecuteContext = CliBackendExecuteContext & {
  assertPrivateInputCurrent?: () => void;
};
export type ClaudeCliTurn = {
  context: ClaudeCliExecuteContext;
  controller: AbortController;
  userInput: ReturnType<typeof createClaudeCliUserInputAuthorizer>;
  /** Fork (F49): explicit session mode, updated when the operator approves a plan. */
  permissionMode?: ClaudeCliPermissionMode;
  planApprover: ReturnType<typeof createClaudeCliPlanApprover>;
  events: PassThrough;
  inputUuid: string;
  /** Replayed user text is never a task receipt, even after its input lifecycle ends. */
  submittedInputUuids: Set<string>;
  inputStarted: boolean;
  promptSubmitted: boolean;
  /** Hook reruns carry no input UUID and may rewrite text; retain their native input owner. */
  promptInputUuid: string;
  sawTerminalResult: boolean;
  interrupted: boolean;
  foregroundTaskIds: Set<string>;
  foregroundBashToolUseIds: Set<string>;
  pendingBackgroundTaskIds: Set<string>;
  taskNotifications: Map<string, "queued" | "replayed">;
  /** Same-turn inputs written to native, keyed by UUID until their lifecycle completes. */
  injectedInputs: Map<
    string,
    {
      text: string;
      promptContext?: CliBackendExecuteContext["promptContext"];
      started: ReturnType<typeof createDeferred<void>>;
    }
  >;
  /**
   * A successful result withheld until every injected input has completed. It is
   * released as terminal on completion, or as interim when native opens another
   * turn for the input first.
   */
  heldResult?: Record<string, unknown>;
  error?: Error;
};
export type ClaudeCliSession = {
  handle: CliBackendLiveSessionHandle;
  capability?: CliBackendLiveSessionCapability;
  transport?: Awaited<ReturnType<typeof createClaudeCliTransport>>;
  transportStartup?: ReturnType<typeof createClaudeCliTransport>;
  currentTurn?: ClaudeCliTurn;
  idleTimer?: ReturnType<typeof setTimeout>;
  hasInputLifecycle: boolean;
  /** The latest turn's prediction sink; native sends the prediction after that turn's result. */
  reportPromptSuggestion?: (text: string) => void;
  /** Fork (F49): the mode the native process was launched with or last switched to. */
  permissionMode: ClaudeCliPermissionMode;
  /** Sent after the approved ExitPlanMode result: the tool itself leaves plan mode. */
  pendingPermissionMode?: ClaudeCliPendingPermissionMode;
  closed: boolean;
  // Tasks outlive inputs; false marks subagent work with no parent-stream query.
  taskOwners: Map<string, string | false>;
  // Native notification results identify task runs rather than task IDs.
  taskRuns: Map<string, string>;
  // Running Agent/Workflow tasks and subagent-owned work, with their launching task.
  runningDescendants: Map<string, string | undefined>;
};
