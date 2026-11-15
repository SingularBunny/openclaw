/**
 * Fork: an image or PDF model on a CLI runtime (Claude by subscription through Claude CLI) has no API key, so the
 * provider API path cannot run it. The image and pdf tools then send their images and prompt as one isolated CLI
 * turn: no tools, no session, the images attached the way chat attachments reach the CLI.
 */
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agent-scope.js";
import {
  resolveIsolatedCompletionProvider,
  resolveIsolatedCompletionRoute,
} from "../isolated-completion-route.js";

export const MEDIA_TOOL_CLI_TIMEOUT_MS = 180_000; // chosen, not measured: a few images or pages read by Claude

/** The CLI that runs this image or PDF model, or undefined when it goes through the provider API. */
export async function resolveMediaToolCliRoute(params: {
  config: OpenClawConfig;
  provider: string;
  model: string;
  agentId?: string;
  agentDir: string;
  workspaceDir?: string;
}): Promise<{ provider: string; cliOwner: string; agentId: string } | undefined> {
  const agentId = params.agentId ?? resolveDefaultAgentId(params.config);
  const { provider, runtimeOverride } = resolveIsolatedCompletionProvider({
    provider: params.provider,
    config: params.config,
  });
  const { cliOwner } = await resolveIsolatedCompletionRoute({
    config: params.config,
    provider,
    model: params.model,
    agentId,
    agentDir: params.agentDir,
    workspaceDir: params.workspaceDir ?? resolveAgentWorkspaceDir(params.config, agentId),
    ...(runtimeOverride ? { runtimeOverride } : {}),
  });
  return cliOwner ? { provider, cliOwner, agentId } : undefined;
}
