// Fork: an ACP turn ends with the same `agent_end` plugin hook as an embedded or CLI turn, so a
// plugin can tell that an ACP agent replied (a group chat waiting for its ACP member, a memory
// plugin capturing the turn). Fired by both ACP paths: a chat bound with `/acp spawn ... --bind`
// (dispatch-acp) and a run started on an ACP session through the Gateway `agent` method
// (runAcpAgentCommand, which `api.runtime.subagent.run` uses). Best effort: a failing or slow
// hook never delays or fails the turn.
import { runAgentHarnessAgentEndHook } from "./lifecycle-hook-helpers.js";

export type AcpTurnAgentEndParams = {
  runId?: string;
  /** The OpenClaw agent that owns the ACP session. */
  agentId: string;
  /** The ACP session the turn ran in. */
  sessionKey: string;
  sessionId?: string;
  /** The ACP harness agent (e.g. "codex"); named as the reply's provider "acp" and model. */
  acpAgent?: string;
  promptText: string;
  finalText: string;
  success: boolean;
  error?: string;
  startedAt?: number;
};

/** The turn as session messages: the prompt and, when the agent wrote any, its reply. */
export function buildAcpTurnAgentEndMessages(params: AcpTurnAgentEndParams): unknown[] {
  const agent = params.acpAgent?.trim();
  const timestamp = Date.now();
  const reply = params.finalText.trim();
  return [
    ...(params.promptText.trim()
      ? [{ role: "user", content: [{ type: "text", text: params.promptText }], timestamp }]
      : []),
    ...(reply
      ? [
          {
            role: "assistant",
            content: [{ type: "text", text: reply }],
            ...(agent ? { provider: "acp", model: agent } : {}),
            stopReason: params.success ? "stop" : "error",
            ...(params.error && !params.success ? { errorMessage: params.error } : {}),
            timestamp,
          },
        ]
      : []),
  ];
}

export function runAcpTurnAgentEndHook(params: AcpTurnAgentEndParams): void {
  const agent = params.acpAgent?.trim();
  runAgentHarnessAgentEndHook({
    event: {
      ...(params.runId ? { runId: params.runId } : {}),
      messages: buildAcpTurnAgentEndMessages(params),
      success: params.success,
      ...(params.error && !params.success ? { error: params.error } : {}),
      ...(params.startedAt ? { durationMs: Math.max(0, Date.now() - params.startedAt) } : {}),
    },
    ctx: {
      ...(params.runId ? { runId: params.runId } : {}),
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      ...(params.sessionId ? { sessionId: params.sessionId } : {}),
      ...(agent ? { modelProviderId: "acp", modelId: agent } : {}),
    },
  });
}
