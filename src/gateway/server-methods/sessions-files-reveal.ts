import {
  isCloudWorkerPlacementState,
  type SessionsFilesRevealParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveAgentRunCwd } from "../../agents/agent-scope.js";
import { getAgentWorkspaceAccess } from "../../agents/workspace-access.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { readSessionWorkerPlacementAsync } from "../worker-environments/session-placement-lifecycle.js";
import {
  formatOpenPathError,
  isHeadlessOpenPathError,
  resolveOpenPathCommand,
  sanitizePathForLog,
} from "./open-path.js";
import { createSessionFileReadAuthority } from "./session-file-read-authority.js";
import { openRevealFolder, selectRevealRoot } from "./sessions-files-reveal-target.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

type RevealSource = Omit<Parameters<typeof createSessionFileReadAuthority>[1], "agentId"> & {
  cfg: OpenClawConfig;
};

/** Fork (F34): reveal from a browse root only under the same host-read authority as browsing it. */
async function selectSessionRevealRoot(
  options: GatewayRequestHandlerOptions,
  loaded: RevealSource,
  agentId: string,
  requested: string | undefined,
) {
  const workspaceRoot = loaded.root ?? "";
  if (!requested?.trim() || requested.trim() === workspaceRoot) {
    return { ok: true as const, root: workspaceRoot };
  }
  const hostRead = createSessionFileReadAuthority(options, { ...loaded, agentId });
  try {
    return await selectRevealRoot({
      requested,
      workspaceRoot,
      runCwd: resolveAgentRunCwd(loaded.cfg, agentId),
      spawnedCwd: loaded.entry?.spawnedCwd,
      authorize: hostRead.authorizeHostRead,
    });
  } finally {
    hostRead.release();
  }
}

/**
 * Opens the session's folder on the Gateway host for `sessions.files.reveal`: the workspace, or
 * (fork, F34) one of its browse roots, and `path` inside it. Refusals answer `ok: false`.
 */
export async function revealSessionFolder(params: {
  options: GatewayRequestHandlerOptions & { params: SessionsFilesRevealParams };
  loaded: RevealSource;
  agentId: string;
  assertCurrent: () => void;
}): Promise<void> {
  const { options, loaded, agentId, assertCurrent } = params;
  const { respond, context } = options;
  const request = options.params;
  if (loaded.entry?.repositoryWorkspaceId) {
    respond(true, {
      ok: false,
      error:
        "This repository exists only on the cloud session runner. Use the Files panel to browse it; there is no Gateway checkout to reveal.",
    });
    return;
  }
  const workspaceRoot = loaded.root;
  if (!workspaceRoot) {
    respond(true, {
      ok: false,
      error: "No workspace root is available for this session.",
    });
    return;
  }
  if (loaded.entry?.execNode || getAgentWorkspaceAccess(workspaceRoot)) {
    respond(true, {
      ok: false,
      path: workspaceRoot,
      error: loaded.entry?.execNode
        ? "Cannot reveal this workspace because the session runs on an exec node."
        : "Cannot reveal this workspace because its files live on a remote host.",
    });
    return;
  }
  const placement = await readSessionWorkerPlacementAsync({
    context,
    sessionId: loaded.entry?.sessionId,
  });
  if (isCloudWorkerPlacementState(placement?.state)) {
    respond(true, {
      ok: false,
      path: workspaceRoot,
      error: `Cannot reveal this workspace because the session runs remotely (${placement.state}).`,
    });
    return;
  }
  const revealRoot = await selectSessionRevealRoot(options, loaded, agentId, request.root);
  if (!revealRoot.ok) {
    respond(true, { ok: false, path: workspaceRoot, error: revealRoot.error });
    return;
  }
  const command = resolveOpenPathCommand(revealRoot.root);
  try {
    const folder = await openRevealFolder(revealRoot.root, request.path, assertCurrent);
    assertCurrent();
    respond(true, { ok: true, path: folder });
  } catch (error) {
    const errorMessage = formatOpenPathError(error);
    const detailedError = isHeadlessOpenPathError(error, command)
      ? `Cannot open path in headless environment. Path: ${workspaceRoot}. This environment appears to lack a graphical or terminal browser handler.`
      : `Failed to reveal session workspace: ${errorMessage}`;
    context.logGateway.warn(
      `sessions.files.reveal failed path=${sanitizePathForLog(workspaceRoot)}: ${errorMessage}`,
    );
    respond(true, { ok: false, path: workspaceRoot, error: detailedError });
  }
}
