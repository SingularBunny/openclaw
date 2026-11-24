// Fork: ACP `session/request_permission` asked in chat with buttons (nonInteractivePermissions: "ask").
import { createHash } from "node:crypto";
import type {
  AcpPermissionPromptDecision,
  AcpPermissionPromptHandler,
  AcpPermissionPromptOption,
  AcpPermissionPromptRequest,
} from "@openclaw/acp-core/runtime/types";
import { runAgentHarnessGatewayQuestion } from "../../agents/harness/gateway-question.js";
import type { AgentHarnessUserInputQuestion } from "../../agents/harness/user-input-types.js";
import { DEFAULT_EXEC_APPROVAL_TIMEOUT_MS } from "../../infra/exec-approvals-core.js";
import type { ReplyPayload } from "../types.js";
import {
  ACP_PERMISSION_STOP_ASKING_HINT as STOP_ASKING_HINT,
  describeAcpPermissionTitle,
} from "./acp-permission-prompt-unavailable.js";

/** Unanswered permission questions deny like unanswered exec approvals (30 min). */
export const ACP_PERMISSION_PROMPT_TIMEOUT_MS = DEFAULT_EXEC_APPROVAL_TIMEOUT_MS;

const QUESTION_ID = "permission";
const DETAIL_LIMIT = 600;

const OPTION_LABELS: Record<string, string> = {
  allow_once: "Allow once",
  allow_always: "Allow always",
  reject_once: "Deny",
  reject_always: "Deny always",
};

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

function describeDetail(rawInput: unknown): string | undefined {
  if (rawInput === undefined || rawInput === null) {
    return undefined;
  }
  let text: string;
  try {
    text = typeof rawInput === "string" ? rawInput : JSON.stringify(rawInput, null, 1);
  } catch {
    return undefined;
  }
  if (!text || text === "{}") {
    return undefined;
  }
  return text.length > DETAIL_LIMIT ? `${text.slice(0, DETAIL_LIMIT - 1)}…` : text;
}

function minutes(ms: number): string {
  const value = Math.max(1, Math.round(ms / 60_000));
  return value === 1 ? "1 minute" : `${value} minutes`;
}

/** Labels follow the ACP option kind, so every agent gets the same buttons. */
export function buildAcpPermissionQuestionOptions(
  options: readonly AcpPermissionPromptOption[],
): Array<{ label: string; value: string }> {
  const used = new Set<string>();
  return options.map((option) => {
    let label = OPTION_LABELS[option.kind] ?? (option.name.trim() || option.optionId);
    if (used.has(label.toLowerCase())) {
      label = `${label} (${option.name.trim() || option.optionId})`;
    }
    used.add(label.toLowerCase());
    return { label, value: option.optionId };
  });
}

export function buildAcpPermissionQuestion(params: {
  request: AcpPermissionPromptRequest;
  agentLabel: string;
  timeoutMs: number;
}): AgentHarnessUserInputQuestion {
  const { request } = params;
  const kind = request.toolKind ? ` (${request.toolKind})` : "";
  const detail = describeDetail(request.rawInput);
  return {
    id: QUESTION_ID,
    header: "Permission",
    question: [
      `${params.agentLabel} asks for permission: ${describeAcpPermissionTitle(request)}${kind}`,
      detail ? `\n${detail}` : undefined,
      `\nNo answer within ${minutes(params.timeoutMs)} denies it.`,
    ]
      .filter(Boolean)
      .join("\n"),
    isOther: false,
    isSecret: false,
    options: buildAcpPermissionQuestionOptions(request.options),
  };
}

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
  const notify = async (text: string) => {
    try {
      await params.delivery.deliver("block", { text });
    } catch {
      // The agent still receives the rejection; the notice is best effort.
    }
  };
  return async (request, context) => {
    const title = describeAcpPermissionTitle(request);
    if (context.signal.aborted || !params.isActive()) {
      return rejected("cancelled", `Permission for "${title}" was not asked: the turn ended.`);
    }
    const question = buildAcpPermissionQuestion({
      request,
      agentLabel: params.agentLabel,
      timeoutMs,
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
}
