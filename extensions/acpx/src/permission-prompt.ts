/**
 * Fork: routes ACP `session/request_permission` that acpx would fail for lack of a
 * TTY (`nonInteractivePermissions: "ask"`) to the OpenClaw turn's chat question.
 * Vendor-neutral: only ACP option kinds and tool kinds are read.
 */
import type { AcpPermissionDecision, AcpPermissionHandler } from "acpx/runtime";
import type { AcpRuntimeTurnInput } from "../runtime-api.js";
import type { AcpxPermissionMode } from "./config-schema.js";

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
  return isReadKind(request.inferredKind) && hasKind(request, ["allow_once", "allow_always"]);
}

/** One grant per tool kind and exact title (a command line or file path), like exec allow-always. */
function grantKey(request: AcpxPermissionRequest): string {
  return JSON.stringify([request.inferredKind ?? "other", request.raw.toolCall.title ?? ""]);
}

function toPromptRequest(request: AcpxPermissionRequest): PermissionPromptRequest {
  const { toolCall } = request.raw;
  return {
    toolCallId: toolCall.toolCallId,
    ...(toolCall.title ? { title: toolCall.title } : {}),
    ...(request.inferredKind ? { toolKind: request.inferredKind } : {}),
    ...(toolCall.rawInput !== undefined ? { rawInput: toolCall.rawInput } : {}),
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
  try {
    const decision = await params.prompt(toPromptRequest(request), { signal });
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
