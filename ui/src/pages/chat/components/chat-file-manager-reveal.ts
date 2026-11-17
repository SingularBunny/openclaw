import type { SessionsFilesRevealResult } from "../../../../../packages/gateway-protocol/src/index.js";
import { canCallGatewayMethod } from "../../../lib/gateway-methods.ts";
import { parseAgentSessionKey } from "../../../lib/sessions/session-key.ts";
import { setChatError } from "../chat-history-state.ts";
import type { ChatPageHost } from "../chat-state-host.ts";
import { resolveSessionWorkspaceRevealTarget } from "./chat-session-workspace.ts";
import type { SidebarContent } from "./chat-sidebar-content-types.ts";

const REVEAL_METHOD = "sessions.files.reveal";

/** The file's path relative to the session workspace, or null when it lies anywhere else. */
export function workspaceRelativeRevealPath(
  roots: readonly string[] | null,
  path: string,
): string | null {
  const target = resolveSessionWorkspaceRevealTarget(roots, path);
  return target.kind === "folder" && target.root === null && target.relativePath
    ? target.relativePath
    : null;
}

/**
 * Fork: "Open folder in file manager" for a file of the session workspace. The Gateway opens the
 * folder on its own host, so the button is offered only to an admin client and only for files the
 * Gateway can place inside the workspace; anything else keeps just Download and Copy path.
 */
export function fileManagerRevealer(
  host: ChatPageHost,
  content: SidebarContent,
): ((path: string) => void) | null {
  if (content.kind !== "file") {
    return null;
  }
  const snapshot = {
    client: host.client,
    hello: host.hello,
    phase: host.connected ? ("connected" as const) : ("offline" as const),
  };
  if (!canCallGatewayMethod(snapshot, REVEAL_METHOD, "operator.admin")) {
    return null;
  }
  const roots = host.sessionWorkspaceState?.roots ?? null;
  if (!workspaceRelativeRevealPath(roots, content.path)) {
    return null;
  }
  return (path: string) => {
    const relativePath = workspaceRelativeRevealPath(roots, path);
    const client = host.client;
    const sessionKey = host.sessionKey;
    if (!relativePath || !client || !sessionKey) {
      return;
    }
    const agentId = parseAgentSessionKey(sessionKey)?.agentId;
    void client
      .request<SessionsFilesRevealResult>(REVEAL_METHOD, {
        key: sessionKey,
        ...(agentId ? { agentId } : {}),
        path: relativePath,
      })
      .then((result) => {
        if (!result.ok) {
          setChatError(host, result.error ?? "Failed to open the folder.", true);
        }
      })
      .catch((error: unknown) => setChatError(host, String(error), true));
  };
}
