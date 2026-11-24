// Fork: ACP permission requests in runs with no chat to ask in (cron, CLI, spawn runs).
import type {
  AcpPermissionPromptHandler,
  AcpPermissionPromptRequest,
} from "@openclaw/acp-core/runtime/types";

const TITLE_LIMIT = 200;

export const ACP_PERMISSION_STOP_ASKING_HINT =
  "To stop these questions, set plugins.entries.acpx.config.permissionMode to approve-all.";

export function describeAcpPermissionTitle(request: AcpPermissionPromptRequest): string {
  const title = request.title?.trim() || request.toolKind || "a tool action";
  return title.length > TITLE_LIMIT ? `${title.slice(0, TITLE_LIMIT - 1)}…` : title;
}

/** Denies at once and says why, instead of failing the turn. */
export function createUnavailableAcpPermissionPromptHandler(params: {
  agentLabel: string;
  notify?: (text: string) => void;
}): AcpPermissionPromptHandler {
  return async (request) => {
    const message =
      `${params.agentLabel} asked for permission for "${describeAcpPermissionTitle(request)}", ` +
      "but this run has no chat to ask in (a scheduled, command-line or spawned run), so it was " +
      "denied and the agent continues without it. Run the task from a chat to approve it there. " +
      ACP_PERMISSION_STOP_ASKING_HINT;
    try {
      params.notify?.(message);
    } catch {
      // Best-effort notice; the agent still receives the rejection.
    }
    return { outcome: "rejected", reason: "unavailable", message };
  };
}
