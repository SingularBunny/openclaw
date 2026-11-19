// Fork (F38, F51): what the ai-workbench fork adds around a subprocess CLI turn, kept out of
// execute-process.ts.
import type { SessionEventTarget } from "../../auto-reply/reply/session-event-contract.js";
import { getAgentRunContext } from "../../infra/agent-run-registry.js";
import {
  type ClaudeNativeCommand,
  recordClaudeNativeCommands,
} from "../../infra/claude-native-commands.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  clearPromptSuggestion,
  emitPromptSuggestion,
} from "../../infra/prompt-suggestion-events.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import { cliBackendLog } from "./log.js";
import type { PreparedCliRunContext } from "./types.js";

/** One pending watchdog notice per session; a newer stall replaces it. */
const CLI_WATCHDOG_EVENT_CONTEXT_KEY = "cli_watchdog";

type RunParams = PreparedCliRunContext["params"];

/**
 * Sinks for what Claude Code reports besides the reply: the predicted next prompt (composer
 * ghost text) and Claude's own commands and skills (composer `/` autocomplete). This run
 * supersedes any earlier prediction; its own may arrive after the run closes. Side questions,
 * isolated completions and restricted runs start Claude without the user's setup.
 */
export function createCliRunForkReporters(params: {
  run: RunParams;
  eventSessionKey?: string;
  eventAgentId?: string;
  eventDelivery?: false;
}) {
  const { run, eventSessionKey, eventAgentId } = params;
  const promptSuggestionSessionKey =
    eventSessionKey &&
    params.eventDelivery !== false &&
    run.executionMode !== "side-question" &&
    !run.isolatedCompletion &&
    getAgentRunContext(run.runId)?.isControlUiVisible !== false
      ? eventSessionKey
      : undefined;
  if (promptSuggestionSessionKey) {
    clearPromptSuggestion(promptSuggestionSessionKey, run.runId);
  }
  const reportPromptSuggestion = promptSuggestionSessionKey
    ? (text: string) => {
        emitPromptSuggestion({
          sessionKey: promptSuggestionSessionKey,
          ...(eventAgentId ? { agentId: eventAgentId } : {}),
          runId: run.runId,
          text,
        });
      }
    : undefined;
  const reportNativeCommands =
    run.executionMode !== "side-question" && !run.isolatedCompletion && !run.cliToolAvailability
      ? (commands: ClaudeNativeCommand[]) => {
          recordClaudeNativeCommands({
            sessionId: run.sessionId,
            agentId: eventAgentId ?? run.agentId,
            commands,
          });
        }
      : undefined;
  return { reportPromptSuggestion, reportNativeCommands };
}

/** Watchdog stall text; a stall before the first model byte gets its own explanation. */
export function cliStallNoticeText(params: {
  provider: string;
  timeoutSeconds: number;
  awaitingModelResponse: boolean;
}): string {
  return [
    `CLI agent (${params.provider}) produced no output for ${params.timeoutSeconds}s and was terminated.`,
    ...(params.awaitingModelResponse
      ? ["It was waiting for the model API to start responding."]
      : [
          "It may have been waiting for interactive input or an approval prompt.",
          "Check CLI permission settings and OpenClaw approval prompts.",
        ]),
  ].join(" ");
}

/**
 * The stall notice is passive. It used to be queued as an `exec` session event, which showed
 * as "background command finished" and woke the agent for an extra turn after the fallback
 * model had already answered. The agent now reads it as a `System:` line at the start of its
 * next turn.
 */
export function enqueueCliStallNotice(
  stallNotice: string,
  params: { sessionKey: string; target: SessionEventTarget },
): void {
  const { target } = params;
  try {
    target.assertCurrent?.();
    enqueueSystemEvent(stallNotice, {
      sessionKey: params.sessionKey,
      contextKey: CLI_WATCHDOG_EVENT_CONTEXT_KEY,
      replace: true,
      ...(target.storePath ? { sessionStorePath: target.storePath } : {}),
      ...(target.deliveryContext ? { deliveryContext: target.deliveryContext } : {}),
    });
  } catch (error) {
    cliBackendLog.warn(`CLI watchdog notice rejected: ${formatErrorMessage(error)}`);
  }
}
