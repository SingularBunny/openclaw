/**
 * Fork: a PDF model on a CLI runtime (Claude by subscription through Claude CLI) has no API key, so the
 * provider API path cannot run it. The pdf tool then extracts locally as for any non-native model (text,
 * scanned pages rendered to images) and sends that as one isolated CLI turn: no tools, no session, the
 * images attached the way chat attachments reach the CLI.
 */
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { Context, ImageContent } from "../../llm/types.js";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agent-scope.js";
import {
  resolveIsolatedCompletionProvider,
  resolveIsolatedCompletionRoute,
} from "../isolated-completion-route.js";

export const PDF_CLI_TIMEOUT_MS = 180_000; // chosen, not measured: a few pages read by Claude

/** The CLI that runs this PDF model, or undefined when it goes through the provider API. */
export async function resolvePdfCliRoute(params: {
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

/** The extraction context as one prompt and its images, in the order the context gives them. */
export function pdfCliPrompt(context: Context): { prompt: string; images: ImageContent[] } {
  const texts: string[] = [];
  const images: ImageContent[] = [];
  for (const message of context.messages) {
    if (message.role !== "user") {
      continue;
    }
    if (typeof message.content === "string") {
      texts.push(message.content);
      continue;
    }
    for (const part of message.content) {
      if (part.type === "text") {
        texts.push(part.text);
      } else if (part.type === "image") {
        images.push({ type: "image", data: part.data, mimeType: part.mimeType });
      }
    }
  }
  return { prompt: texts.join("\n\n"), images };
}
