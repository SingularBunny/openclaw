/**
 * Fork: routes ACP `session/request_permission` that acpx would fail for lack of a
 * TTY (`nonInteractivePermissions: "ask"`) to the OpenClaw turn's chat question.
 * Vendor-neutral: only ACP option kinds and tool kinds are read.
 */
import type { AcpPermissionDecision, AcpPermissionHandler } from "acpx/runtime";
import type { AcpRuntimeTurnInput } from "../runtime-api.js";
import type { AcpxPermissionMode } from "./config-schema.js";
import { acpxPermissionModes, type AcpxSessionPermissionModes } from "./permission-modes.js";

type PermissionPromptHandler = NonNullable<AcpRuntimeTurnInput["onPermissionPrompt"]>;
type PermissionPromptRequest = Parameters<PermissionPromptHandler>[0];
type AcpxPermissionRequest = Parameters<AcpPermissionHandler>[0];

const MAX_REMEMBERED_PER_SESSION = 256;
const MAX_REMEMBERED_SESSIONS = 512;

/** "Allow always" answers per OpenClaw ACP session, for agents that ask again anyway. */
export class AcpxPermissionGrants {
  private readonly sessions = new Map<string, Set<string>>();

  has(sessionKey: string, grant: string): boolean {
    return this.sessions.get(sessionKey)?.has(grant) === true;
  }

  add(sessionKey: string, grant: string): void {
    let grants = this.sessions.get(sessionKey);
    if (!grants) {
      if (this.sessions.size >= MAX_REMEMBERED_SESSIONS) {
        const oldest = this.sessions.keys().next().value;
        if (oldest !== undefined) {
          this.sessions.delete(oldest);
        }
      }
      grants = new Set();
      this.sessions.set(sessionKey, grants);
    }
    if (grants.size >= MAX_REMEMBERED_PER_SESSION) {
      const oldest = grants.values().next().value;
      if (oldest !== undefined) {
        grants.delete(oldest);
      }
    }
    grants.add(grant);
  }

  forget(sessionKey: string): void {
    this.sessions.delete(sessionKey);
  }
}

function isReadKind(kind: string | undefined): boolean {
  return kind === "read" || kind === "search";
}

function hasKind(request: AcpxPermissionRequest, kinds: readonly string[]): boolean {
  return request.raw.options.some((option) => kinds.includes(option.kind));
}

const PERMISSION_WORDING =
  /^(?:|once|always|yes|no|ok)$|^(?:always|allow|approve|accept|reject|deny|never)\b/i;

/**
 * An agent may use `session/request_permission` for a decision of its own (a plan review:
 * Implement / Revise / Stop). Options not worded as allow/deny are such a decision, and a
 * read rule must never answer it. Mirrors `isAcpDecisionRequest` in the chat question.
 */
export function isAcpxDecisionRequest(request: AcpxPermissionRequest): boolean {
  return request.raw.options.some((option) => !PERMISSION_WORDING.test(option.name.trim()));
}

/**
 * True when acpx's own policy settles the request without a prompt: approve-all,
 * deny-all, no options, or a read under approve-reads. Mirrors acpx 0.21
 * `resolvePermissionByPolicy` (no `permissionPolicy` is configured by OpenClaw).
 */
export function acpxSettlesWithoutPrompt(
  request: AcpxPermissionRequest,
  permissionMode: AcpxPermissionMode,
): boolean {
  if (request.raw.options.length === 0) {
    return true;
  }
  if (permissionMode === "approve-all" || permissionMode === "deny-all") {
    return true;
  }
  return (
    isReadKind(request.inferredKind) &&
    hasKind(request, ["allow_once", "allow_always"]) &&
    !isAcpxDecisionRequest(request)
  );
}

function locationPaths(request: AcpxPermissionRequest): string[] {
  return (request.raw.toolCall.locations ?? []).flatMap((location) =>
    typeof location?.path === "string" && location.path.trim() ? [location.path.trim()] : [],
  );
}

function stableInput(rawInput: unknown): string {
  try {
    return JSON.stringify(rawInput ?? null) ?? "null";
  } catch {
    return "unserializable";
  }
}

/**
 * One grant per exact request: tool kind, title, files and input, like exec allow-always on
 * one command line. A generic title ("Allow viewing files?") alone must not carry an
 * "always" answer over to other files; the agent keeps its own scope (an allowlist pattern)
 * for the option it offered.
 */
function grantKey(request: AcpxPermissionRequest): string {
  return JSON.stringify([
    request.inferredKind ?? "other",
    request.raw.toolCall.title ?? "",
    locationPaths(request),
    stableInput(request.raw.toolCall.rawInput),
  ]);
}

/**
 * The allow option "allow all" answers with: once if offered, else always. None for a decision
 * (plan review, step limit) or a request with no allow option: those are still asked.
 */
function allowAllOption(request: AcpxPermissionRequest) {
  if (isAcpxDecisionRequest(request)) {
    return undefined;
  }
  return (
    request.raw.options.find((option) => option.kind === "allow_once") ??
    request.raw.options.find((option) => option.kind === "allow_always")
  );
}

function toPromptRequest(request: AcpxPermissionRequest): PermissionPromptRequest {
  const { toolCall } = request.raw;
  return {
    ...(allowAllOption(request) ? { allowAllOffered: true } : {}),
    toolCallId: toolCall.toolCallId,
    ...(toolCall.title ? { title: toolCall.title } : {}),
    ...(request.inferredKind ? { toolKind: request.inferredKind } : {}),
    ...(toolCall.rawInput !== undefined ? { rawInput: toolCall.rawInput } : {}),
    ...(locationPaths(request).length > 0 ? { locations: locationPaths(request) } : {}),
    options: request.raw.options.map((option) => ({
      optionId: option.optionId,
      name: option.name,
      kind: option.kind,
    })),
  };
}

const REJECT: AcpPermissionDecision = { outcome: "reject_once" };

type BridgeParams = {
  permissionMode: AcpxPermissionMode;
  sessionKey: string;
  prompt?: PermissionPromptHandler;
  grants: AcpxPermissionGrants;
  /** Per-session "allow all"; the plugin's shared instance unless a test passes its own. */
  modes?: AcpxSessionPermissionModes;
  log?: (message: string) => void;
};

/**
 * Session-level acpx permissions under "ask" with approve-reads. The bridge now
 * answers every `session/request_permission` (the user's click is the approval),
 * so acpx's own mode becomes approve-all: otherwise a file write or terminal the
 * agent delegates back to the client after an approved request would hit acpx's
 * TTY-only fs/terminal gate and fail the turn. Native harness sessions do the same.
 * Delegated operations stay confined to the session cwd by acpx.
 */
export function acpxAskSessionPermissions(params: BridgeParams): {
  permissionMode?: "approve-all";
  onPermissionRequest?: AcpPermissionHandler;
} {
  if (params.permissionMode !== "approve-reads") {
    return {};
  }
  // Requests outside a live turn have no chat to ask in: deny, never fall through.
  return {
    permissionMode: "approve-all",
    onPermissionRequest: createAcpxPermissionPromptBridge({ ...params, prompt: undefined }),
  };
}

/**
 * Builds the per-turn acpx permission handler. Returns `undefined` when acpx's
 * configured policy should run unchanged. A turn without a prompt handler
 * (no chat surface) is denied, never failed.
 */
export function createAcpxPermissionPromptBridge(params: BridgeParams): AcpPermissionHandler {
  return async (request, context) => {
    if (acpxSettlesWithoutPrompt(request, params.permissionMode)) {
      return undefined;
    }
    try {
      return await askOrRemember(params, request, context.signal);
    } catch {
      // Never fall through: under "ask" acpx's own mode may be approve-all.
      return REJECT;
    }
  };
}

async function askOrRemember(
  params: BridgeParams,
  request: AcpxPermissionRequest,
  signal: AbortSignal,
): Promise<AcpPermissionDecision> {
  const key = grantKey(request);
  if (params.grants.has(params.sessionKey, key)) {
    const remembered = request.raw.options.find((option) => option.kind === "allow_always");
    return remembered
      ? { outcome: "selected", optionId: remembered.optionId }
      : { outcome: "allow_once" };
  }
  if (!params.prompt) {
    params.log?.(
      `acpx: denied permission for "${request.raw.toolCall.title ?? "tool"}" in ${params.sessionKey}: ` +
        "this turn has no chat to ask in (nonInteractivePermissions=ask).",
    );
    return REJECT;
  }
  const modes = params.modes ?? acpxPermissionModes;
  const allowAll = allowAllOption(request);
  const allowAllDecision = (): AcpPermissionDecision => ({
    outcome: "selected",
    optionId: allowAll!.optionId,
  });
  if (allowAll && (await modes.isAllowAll(params.sessionKey).catch(() => false))) {
    return allowAllDecision();
  }
  // Switching the session to allow-all while this question is open (or queued) answers it.
  const switched = new AbortController();
  const stopWatching = allowAll
    ? modes.onAllowAll(params.sessionKey, () => switched.abort())
    : () => {};
  try {
    let decision: Awaited<ReturnType<PermissionPromptHandler>>;
    try {
      decision = await params.prompt(toPromptRequest(request), {
        signal: AbortSignal.any([signal, switched.signal]),
      });
    } finally {
      stopWatching();
    }
    if (decision.outcome === "rejected" && switched.signal.aborted && !signal.aborted && allowAll) {
      return allowAllDecision();
    }
    if (decision.outcome === "selected" && decision.allowAll && allowAll) {
      await modes.set(params.sessionKey, "allow-all").catch((error: unknown) => {
        params.log?.(
          `acpx: could not switch ${params.sessionKey} to allow all: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
      return allowAllDecision();
    }
    if (decision.outcome === "rejected") {
      params.log?.(`acpx: permission denied (${decision.reason}): ${decision.message}`);
      return REJECT;
    }
    const option = request.raw.options.find((entry) => entry.optionId === decision.optionId);
    if (!option) {
      return REJECT;
    }
    if (option.kind === "allow_always") {
      params.grants.add(params.sessionKey, key);
    }
    return { outcome: "selected", optionId: option.optionId };
  } catch (error) {
    params.log?.(
      `acpx: permission question failed, denying: ${error instanceof Error ? error.message : String(error)}`,
    );
    return REJECT;
  }
}
