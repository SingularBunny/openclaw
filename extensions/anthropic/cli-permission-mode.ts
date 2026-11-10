// Fork (F49): Claude Code permission modes and plan approval for `claude-cli` sessions.
//
// Every native tool reaches OpenClaw through the PreToolUse hook or `can_use_tool`, and a hook
// "allow" skips Claude's own permission checks. The session mode is therefore enforced here, on
// top of host policy: host denials always win, and a mode only adds prompts or plan-mode denials.
import type {
  CliBackendExecuteContext,
  CliBackendToolPermissionResult,
} from "openclaw/plugin-sdk/cli-backend";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/string-coerce-runtime";

/** Values of `claude --permission-mode` (Claude Agent SDK `PermissionMode`). */
export const CLAUDE_CLI_PERMISSION_MODES = [
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
  "dontAsk",
  "auto",
] as const;
export type ClaudeCliPermissionMode = (typeof CLAUDE_CLI_PERMISSION_MODES)[number];

export function readClaudeCliPermissionMode(raw: unknown): ClaudeCliPermissionMode | undefined {
  return CLAUDE_CLI_PERMISSION_MODES.find((mode) => mode === raw);
}

const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);
const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);

export type ClaudeCliModeGate =
  | { kind: "host" }
  | { kind: "ask" }
  | { kind: "deny"; message: string };

const PLAN_MODE_EDIT_DENIAL =
  "Plan mode is on: do not change files yet. Finish the plan and present it with ExitPlanMode for approval.";

/**
 * What the session mode adds to host policy for one native tool, as in Claude Code:
 * default asks for edits and shell commands, acceptEdits only for shell commands, plan refuses
 * edits. bypassPermissions, dontAsk, and auto, like no explicit mode, leave host policy as is.
 */
export function resolveClaudeCliModeGate(
  mode: ClaudeCliPermissionMode | undefined,
  toolName: string,
): ClaudeCliModeGate {
  const edit = EDIT_TOOLS.has(toolName);
  const shell = SHELL_TOOLS.has(toolName);
  switch (mode) {
    case "default":
      return edit || shell ? { kind: "ask" } : { kind: "host" };
    case "acceptEdits":
      return shell ? { kind: "ask" } : { kind: "host" };
    case "plan":
      return edit
        ? { kind: "deny", message: PLAN_MODE_EDIT_DENIAL }
        : shell
          ? { kind: "ask" }
          : { kind: "host" };
    default:
      return { kind: "host" };
  }
}

export const CLAUDE_CLI_PLAN_QUESTION_ID = "plan_approval";
export const CLAUDE_CLI_PLAN_OPTIONS = {
  acceptEdits: "Yes, and auto-accept edits",
  default: "Yes, and manually approve edits",
  keepPlanning: "No, keep planning",
} as const;
const PLAN_INTRO_MAX_CHARS = 8_000;

/** An approved plan carries the mode the session continues in; a rejected one stays in plan. */
export type ClaudeCliPlanDecision = {
  result: CliBackendToolPermissionResult & {
    updatedPermissions?: Array<{
      type: "setMode";
      mode: ClaudeCliPermissionMode;
      destination: "session";
    }>;
  };
  mode?: "acceptEdits" | "default";
};

/** One plan card per ExitPlanMode call: the hook and `can_use_tool` share its decision. */
export function createClaudeCliPlanApprover(context: CliBackendExecuteContext) {
  const requests = new Map<string, Promise<ClaudeCliPlanDecision>>();
  return {
    /** The hook already decided this call; can_use_tool must get the same answer. */
    has(toolUseId: string | undefined): boolean {
      return toolUseId !== undefined && requests.has(toolUseId);
    },
    approve(params: {
      input: Record<string, unknown>;
      signal: AbortSignal;
      toolUseId?: string;
    }): Promise<ClaudeCliPlanDecision> {
      const existing = params.toolUseId ? requests.get(params.toolUseId) : undefined;
      if (existing) {
        return existing;
      }
      const request = askPlanApproval(context, params);
      if (params.toolUseId) {
        requests.set(params.toolUseId, request);
      }
      return request;
    },
  };
}

async function askPlanApproval(
  context: CliBackendExecuteContext,
  params: { input: Record<string, unknown>; signal: AbortSignal; toolUseId?: string },
): Promise<ClaudeCliPlanDecision> {
  const plan = typeof params.input.plan === "string" ? params.input.plan.trim() : "";
  const result = await context.requestUserInput({
    toolName: "ExitPlanMode",
    questions: [
      {
        id: CLAUDE_CLI_PLAN_QUESTION_ID,
        header: "Plan",
        question: "Claude has finished planning. Would you like to proceed?",
        multiSelect: false,
        // A typed answer is feedback for the next version of the plan.
        isOther: true,
        options: [
          {
            label: CLAUDE_CLI_PLAN_OPTIONS.acceptEdits,
            description: "Approve the plan; file edits are applied without asking.",
          },
          {
            label: CLAUDE_CLI_PLAN_OPTIONS.default,
            description: "Approve the plan; each edit and command asks first.",
          },
          {
            label: CLAUDE_CLI_PLAN_OPTIONS.keepPlanning,
            description: "Stay in plan mode. Type instead to tell Claude what to change.",
          },
        ],
      },
    ],
    intro: plan
      ? `Claude's plan:\n\n${truncateUtf16Safe(plan, PLAN_INTRO_MAX_CHARS)}`
      : "Claude has finished planning:",
    ...(params.toolUseId ? { toolCallId: params.toolUseId } : {}),
    abortSignal: params.signal,
  });
  if (result.status !== "answered") {
    return {
      result: {
        behavior: "deny",
        message: `${result.message} The plan was not approved; stay in plan mode and wait for the user.`,
      },
    };
  }
  const answer = (result.answers[CLAUDE_CLI_PLAN_QUESTION_ID] ?? []).join(", ").trim();
  const mode =
    answer === CLAUDE_CLI_PLAN_OPTIONS.acceptEdits
      ? "acceptEdits"
      : answer === CLAUDE_CLI_PLAN_OPTIONS.default
        ? "default"
        : undefined;
  if (mode) {
    return {
      result: {
        behavior: "allow",
        updatedInput: params.input,
        updatedPermissions: [{ type: "setMode", mode, destination: "session" }],
      },
      mode,
    };
  }
  return {
    result: {
      behavior: "deny",
      message:
        !answer || answer === CLAUDE_CLI_PLAN_OPTIONS.keepPlanning
          ? "The user chose to keep planning. Stay in plan mode and ask what to change in the plan."
          : `The user chose to keep planning and gave this feedback on the plan:\n\n${answer}\n\nStay in plan mode, revise the plan, and present it again with ExitPlanMode.`,
    },
  };
}

/** Stream-json control request that switches a running Claude CLI to another mode. */
export function createSetPermissionModeRequest(mode: ClaudeCliPermissionMode, requestId: string) {
  return {
    type: "control_request",
    request_id: `set_permission_mode_${requestId}`,
    request: { subtype: "set_permission_mode", mode },
  };
}
