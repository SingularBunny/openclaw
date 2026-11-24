// Fork: ACP `session/request_permission` asked in chat with buttons (nonInteractivePermissions: "ask").
import { createHash } from "node:crypto";
import type {
  AcpPermissionPromptDecision,
  AcpPermissionPromptHandler,
} from "@openclaw/acp-core/runtime/types";
import { runAgentHarnessGatewayQuestion } from "../../agents/harness/gateway-question.js";
import { DEFAULT_EXEC_APPROVAL_TIMEOUT_MS } from "../../infra/exec-approvals-core.js";
import type { ReplyPayload } from "../types.js";
import {
  ACP_PERMISSION_QUESTION_ID as QUESTION_ID,
  buildAcpPermissionDetailMessage,
  buildAcpPermissionQuestion,
  formatAcpPermissionMinutes as minutes,
} from "./acp-permission-prompt-text.js";
import {
  ACP_PERMISSION_STOP_ASKING_HINT as STOP_ASKING_HINT,
  describeAcpPermissionTitle,
} from "./acp-permission-prompt-unavailable.js";
import { inAcpQuestionQueue } from "./acp-question-queue.js";

export {
  buildAcpPermissionQuestion,
  buildAcpPermissionQuestionOptions,
  describeAcpPermissionOptionScope,
  isAcpDecisionRequest,
  renderAcpPermissionInput,
} from "./acp-permission-prompt-text.js";

/** Unanswered permission questions deny like unanswered exec approvals (30 min). */
export const ACP_PERMISSION_PROMPT_TIMEOUT_MS = DEFAULT_EXEC_APPROVAL_TIMEOUT_MS;

export type AcpPermissionPromptHandlerParams = {
  /** Session the question belongs to; its chat shows the buttons. */
  sessionKey: string;
  /** Stable per-turn scope for question ids. */
  outerRequestId: string;
  /** Name the user knows the ACP agent by (for example `junie`). */
  agentLabel: string;
  agentId?: string;
  runId?: string;
  delivery: {
    deliver: (kind: "block", payload: ReplyPayload) => Promise<boolean>;
  };
  isActive: () => boolean;
  timeoutMs?: number;
  /** Test seam; production uses the Gateway question service. */
  askQuestion?: typeof runAgentHarnessGatewayQuestion;
};

function rejected(
  reason: "timeout" | "unavailable" | "cancelled",
  message: string,
): AcpPermissionPromptDecision {
  return { outcome: "rejected", reason, message };
}

function questionId(params: AcpPermissionPromptHandlerParams, toolCallId: string, seq: number) {
  const digest = createHash("sha256")
    .update(JSON.stringify([params.sessionKey, params.outerRequestId, toolCallId, seq]))
    .digest("hex")
    .slice(0, 24);
  return `acpperm_${digest}`;
}

/** Creates the turn-owned bridge from ACP permission requests to a chat question with buttons. */
export function createAcpPermissionPromptHandler(
  params: AcpPermissionPromptHandlerParams,
): AcpPermissionPromptHandler {
  const timeoutMs = params.timeoutMs ?? ACP_PERMISSION_PROMPT_TIMEOUT_MS;
  const ask = params.askQuestion ?? runAgentHarnessGatewayQuestion;
  let seq = 0;
  const tryDeliver = async (text: string): Promise<boolean> => {
    try {
      return await params.delivery.deliver("block", { text });
    } catch {
      // Best effort: the agent still receives its answer or rejection.
      return false;
    }
  };
  const notify = async (text: string) => {
    await tryDeliver(text);
  };
  const askOne: AcpPermissionPromptHandler = async (request, context) => {
    const title = describeAcpPermissionTitle(request);
    if (context.signal.aborted || !params.isActive()) {
      return rejected("cancelled", `Permission for "${title}" was not asked: the turn ended.`);
    }
    // Input too long for the question (a plan, a file body) is posted in full first.
    const detailMessage = buildAcpPermissionDetailMessage({
      request,
      agentLabel: params.agentLabel,
    });
    const detailShownAbove = detailMessage !== undefined && (await tryDeliver(detailMessage));
    const question = buildAcpPermissionQuestion({
      request,
      agentLabel: params.agentLabel,
      timeoutMs,
      detailShownAbove,
    });
    const startedAt = Date.now();
    let result: Awaited<ReturnType<typeof runAgentHarnessGatewayQuestion>>;
    try {
      result = await ask({
        questions: [question],
        sessionKey: params.sessionKey,
        agentId: params.agentId,
        runId: params.runId,
        timeoutMs,
        signal: context.signal,
        questionId: questionId(params, request.toolCallId ?? "", seq++),
        promptOptions: { intro: "ACP agent needs permission:" },
        delivery: {
          onBlockReply: async (payload) => {
            if (!(await params.delivery.deliver("block", payload))) {
              throw new Error("this conversation has no chat that can show the question");
            }
          },
        },
      });
    } catch (error) {
      if (context.signal.aborted) {
        return rejected("cancelled", `Permission for "${title}" was cancelled: the turn ended.`);
      }
      const why = error instanceof Error && error.message ? error.message : String(error);
      const message =
        `Could not ask for permission in this chat (${why}), so ${params.agentLabel} was denied ` +
        `"${title}" and continues without it. Answer any open question in this chat and ask ` +
        `${params.agentLabel} to retry. ${STOP_ASKING_HINT}`;
      await notify(message);
      return rejected("unavailable", message);
    }
    if (result.status === "answered") {
      const answer = result.answers.answers[QUESTION_ID]?.[0]?.trim();
      const options = question.options ?? [];
      const chosen = options.find(
        (option) => option.value === answer || option.label.toLowerCase() === answer?.toLowerCase(),
      );
      const optionId = chosen?.value;
      if (optionId && request.options.some((option) => option.optionId === optionId)) {
        return { outcome: "selected", optionId };
      }
      const message = `Permission answer "${answer ?? ""}" matches no button, so "${title}" was denied. Ask ${params.agentLabel} to retry and press one of the buttons.`;
      await notify(message);
      return rejected("cancelled", message);
    }
    if (context.signal.aborted || !params.isActive()) {
      return rejected("cancelled", `Permission for "${title}" was cancelled: the turn ended.`);
    }
    if (result.status === "expired" || Date.now() - startedAt >= timeoutMs) {
      const message =
        `Permission request timed out: no answer within ${minutes(timeoutMs)}, so ` +
        `${params.agentLabel} was denied "${title}" and continues without it. To allow it, ask ` +
        `${params.agentLabel} to try again and press Allow. ${STOP_ASKING_HINT}`;
      await notify(message);
      return rejected("timeout", message);
    }
    const message = `The permission question for "${title}" was closed without an answer, so ${params.agentLabel} was denied it and continues without it. Ask ${params.agentLabel} to retry to be asked again.`;
    await notify(message);
    return rejected("cancelled", message);
  };
  return async (request, context) =>
    await inAcpQuestionQueue(params.sessionKey, context.signal, () => askOne(request, context));
}
