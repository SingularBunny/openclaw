// Fork: what an ACP permission or decision question says and which buttons it shows.
import type {
  AcpPermissionPromptOption,
  AcpPermissionPromptRequest,
} from "@openclaw/acp-core/runtime/types";
import type { AgentHarnessUserInputQuestion } from "../../agents/harness/user-input-types.js";
import { describeAcpPermissionTitle } from "./acp-permission-prompt-unavailable.js";

export const ACP_PERMISSION_QUESTION_ID = "permission";

/** Fork: value of the "Allow all in this chat" button; never an ACP option id. */
export const ACP_PERMISSION_ALLOW_ALL_VALUE = "openclaw:allow-all";

/** Longer input than this goes to a chat message of its own before the buttons. */
export const ACP_PERMISSION_INLINE_DETAIL_LIMIT = 600;
const MAX_LOCATIONS = 5;
const SHORT_FIELD = 160;
const OPTION_HINT_LIMIT = 48;

const OPTION_LABELS: Record<string, string> = {
  allow_once: "Allow once",
  allow_always: "Allow always",
  reject_once: "Deny",
  reject_always: "Deny always",
};

const LEADING_VERB =
  /^(?:always\s+allow|allow\s+always|always\s+deny|deny\s+always|always|allow|approve|accept|reject|deny|never)\b[\s:,.-]*/i;
const UNINFORMATIVE_HINT = /^(?:|once|always|yes|no|ok|this time|only this time|just this once)$/i;

function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/**
 * What an agent's own option name adds to the kind label: the scope of an "always" answer
 * (`Always allow ("/repo/*")` gives `/repo/*`, `Allow for this session` gives
 * `for this session`), or nothing when the name only repeats the kind.
 */
export function describeAcpPermissionOptionScope(name: string): string | undefined {
  const trimmed = name.trim();
  const parenthesized = /\(([^()]*)\)\s*$/.exec(trimmed)?.[1];
  const raw = parenthesized ?? trimmed.replace(LEADING_VERB, "");
  const hint = raw
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .trim();
  return UNINFORMATIVE_HINT.test(hint) ? undefined : hint;
}

/** An option worded as a permission answer: allow/deny/approve..., yes/no, or the bare kind. */
function isPermissionWorded(option: AcpPermissionPromptOption): boolean {
  const name = option.name.trim();
  return !name || UNINFORMATIVE_HINT.test(name) || LEADING_VERB.test(name);
}

/**
 * True when the agent uses `session/request_permission` for a decision of its own rather than
 * a permission (Junie's plan review: Implement / Spawn agentic team / Revise / Save the plan
 * and stop). Its options carry ACP kinds, but the names are what the user must choose between.
 */
export function isAcpDecisionRequest(options: readonly AcpPermissionPromptOption[]): boolean {
  return options.some((option) => !isPermissionWorded(option));
}

/**
 * Permission buttons follow the ACP option kind, so every agent gets the same ones: "Allow
 * once", "Allow always", "Deny". The agent's own wording goes to the description as a scope
 * hint; a kind offered twice (two "always" scopes) puts the scope in the label. A decision
 * (see `isAcpDecisionRequest`) shows the agent's own option names instead.
 */
export function buildAcpPermissionQuestionOptions(
  options: readonly AcpPermissionPromptOption[],
): Array<{ label: string; value: string; description?: string }> {
  const decision = isAcpDecisionRequest(options);
  const kindCount = new Map<string, number>();
  for (const option of options) {
    kindCount.set(option.kind, (kindCount.get(option.kind) ?? 0) + 1);
  }
  const used = new Set<string>();
  return options.map((option, index) => {
    const kindLabel = decision ? undefined : OPTION_LABELS[option.kind];
    const scope = describeAcpPermissionOptionScope(option.name);
    let label: string;
    let description: string | undefined;
    if (!kindLabel) {
      label = option.name.trim() || OPTION_LABELS[option.kind] || option.optionId;
    } else if ((kindCount.get(option.kind) ?? 0) > 1 && scope) {
      label = `${kindLabel}: ${clip(scope, OPTION_HINT_LIMIT)}`;
    } else {
      label = kindLabel;
      description = scope;
    }
    if (used.has(label.toLowerCase())) {
      label = `${label} (${index + 1})`;
    }
    used.add(label.toLowerCase());
    return { label, value: option.optionId, ...(description ? { description } : {}) };
  });
}

/**
 * The allow option an "Allow all in this chat" answer selects for the request at hand: once if
 * offered, else always. None for a decision or a request without an allow option.
 */
export function resolveAcpAllowAllOption(
  options: readonly AcpPermissionPromptOption[],
): AcpPermissionPromptOption | undefined {
  if (isAcpDecisionRequest(options)) {
    return undefined;
  }
  return (
    options.find((option) => option.kind === "allow_once") ??
    options.find((option) => option.kind === "allow_always")
  );
}

function renderField(key: string, value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value === "string") {
    const text = value.trim();
    return text.length <= SHORT_FIELD && !text.includes("\n") ? `${key}: ${text}` : text;
  }
  try {
    return `${key}: ${JSON.stringify(value)}`;
  } catch {
    return undefined;
  }
}

/**
 * The tool input as a person reads it: a string as is, an object field by field, with long or
 * multi-line text (a plan in markdown, a file body) as its own paragraph, never escaped JSON.
 */
export function renderAcpPermissionInput(rawInput: unknown): string | undefined {
  if (rawInput === undefined || rawInput === null) {
    return undefined;
  }
  if (typeof rawInput === "string") {
    return rawInput.trim() || undefined;
  }
  if (typeof rawInput === "object" && !Array.isArray(rawInput)) {
    const parts = Object.entries(rawInput as Record<string, unknown>).flatMap(([key, value]) => {
      const part = renderField(key, value);
      return part ? [part] : [];
    });
    return parts.length > 0 ? parts.join("\n\n") : undefined;
  }
  try {
    return JSON.stringify(rawInput, null, 1);
  } catch {
    return undefined;
  }
}

function describeLocations(locations: readonly string[] | undefined): string | undefined {
  const paths = [...new Set((locations ?? []).map((path) => path.trim()).filter(Boolean))];
  if (paths.length === 0) {
    return undefined;
  }
  const shown = paths.slice(0, MAX_LOCATIONS).join("\n");
  const more = paths.length > MAX_LOCATIONS ? `\n… and ${paths.length - MAX_LOCATIONS} more` : "";
  return `${paths.length === 1 ? "File" : "Files"}:\n${shown}${more}`;
}

function minutes(ms: number): string {
  const value = Math.max(1, Math.round(ms / 60_000));
  return value === 1 ? "1 minute" : `${value} minutes`;
}

export function formatAcpPermissionMinutes(ms: number): string {
  return minutes(ms);
}

/** Input that does not fit the question goes to the chat as a message first; this is its text. */
export function buildAcpPermissionDetailMessage(params: {
  request: AcpPermissionPromptRequest;
  agentLabel: string;
}): string | undefined {
  const detail = renderAcpPermissionInput(params.request.rawInput);
  if (!detail || detail.length <= ACP_PERMISSION_INLINE_DETAIL_LIMIT) {
    return undefined;
  }
  return `**${params.agentLabel}: ${describeAcpPermissionTitle(params.request)}**\n\n${detail}`;
}

export function buildAcpPermissionQuestion(params: {
  request: AcpPermissionPromptRequest;
  agentLabel: string;
  timeoutMs: number;
  /** The full input was sent as a chat message just before the question. */
  detailShownAbove?: boolean;
}): AgentHarnessUserInputQuestion {
  const { request } = params;
  const decision = isAcpDecisionRequest(request.options);
  // "other" is acpx's guess for an unknown title; it tells the user nothing.
  const kind = request.toolKind && request.toolKind !== "other" ? ` (${request.toolKind})` : "";
  const title = describeAcpPermissionTitle(request);
  const locations = describeLocations(request.locations);
  const rendered = renderAcpPermissionInput(request.rawInput);
  const detail = params.detailShownAbove
    ? "The full text is in the message above."
    : rendered && clip(rendered, ACP_PERMISSION_INLINE_DETAIL_LIMIT);
  const outcome = decision ? "stops it" : "denies it";
  return {
    id: ACP_PERMISSION_QUESTION_ID,
    header: decision ? "Decision" : "Permission",
    question: [
      decision
        ? `${params.agentLabel} asks: ${title}`
        : `${params.agentLabel} asks for permission: ${title}${kind}`,
      locations ? `\n${locations}` : undefined,
      detail ? `\n${detail}` : undefined,
      `\nNo answer within ${minutes(params.timeoutMs)} ${outcome}.`,
    ]
      .filter(Boolean)
      .join("\n"),
    isOther: false,
    isSecret: false,
    options: [
      ...buildAcpPermissionQuestionOptions(request.options),
      // Fork: switches the ACP session to allow every later permission request (not decisions).
      ...(request.allowAllOffered && !decision && resolveAcpAllowAllOption(request.options)
        ? [
            {
              label: "Allow all in this chat",
              value: ACP_PERMISSION_ALLOW_ALL_VALUE,
              description: `Allow this and every later permission request of ${params.agentLabel} until you switch back to Ask by the composer or the agent is closed`,
            },
          ]
        : []),
    ],
  };
}
