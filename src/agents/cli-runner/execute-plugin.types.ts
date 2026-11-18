import type { ProgressCardStep } from "../../../packages/gateway-protocol/src/schema/progress-card.js";
import type {
  CliBackendExecute,
} from "../../plugins/cli-backend.types.js";
import type { CliTerminalInterruption } from "../cli-output-contracts.js";
import type { FailoverError } from "../failover-error.js";
import type { CliBackgroundTasksState } from "./native-wait-state.js";
import type { CliMcpCapture, PreparedCliRunContext } from "./types.js";

// Inputs of executePluginOwnedProcess (execute-plugin.ts); the fork adds background tasks, todos
// and prompt predictions.
export type ExecutePluginOwnedProcessParams = {
  context: PreparedCliRunContext;
  execute: CliBackendExecute;
  executionCommand: string;
  executionArgv0?: string;
  executionArgs: readonly string[];
  env: Record<string, string>;
  prompt: string;
  promptContext?: PreparedCliRunContext["promptContext"];
  useResume: boolean;
  forceNewSession?: boolean;
  sessionId?: string;
  noOutputTimeoutMs: number;
  consumeStdout: (chunk: string) => void;
  onOutstandingWorkChange?: (active: boolean) => void;
  activeToolCount?: () => number;
  compactionActive?: () => boolean;
  setOnCompactionActiveChange?: (listener: (() => void) | undefined) => void;
  getActiveLoopbackAskUserDeadline?: () => number | undefined;
  setOnActiveLoopbackAskUserDeadlineChange?: (listener: (() => void) | undefined) => void;
  onNoOutputTimeout?: (error: FailoverError) => void;
  /** Fork (F33): live background tasks of the CLI; `waiting` once the main answer is in. */
  onBackgroundTasksChange?: (state: CliBackgroundTasksState) => void;
  /** Fork (F45): Claude's todo list as progress-card steps, whenever it changes. */
  onTodosChange?: (steps: ProgressCardStep[]) => void;
  onInterrupted?: (reason: CliTerminalInterruption["reason"]) => boolean;
  /** Late-arriving next-prompt prediction; outlives the run like the warm process. */
  onPromptSuggestion?: (text: string) => void;
  mcpCapture?: CliMcpCapture;
  liveSession?: {
    requiredGeneration?: string;
  };
};
