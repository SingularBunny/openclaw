import path from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { resolveAgentDir, resolveAgentWorkspaceDir } from "../../agents/agent-scope-config.js";
import { loadCliSessionEntries } from "../../agents/cli-runner/session-history.js";
import { clearCliSessionInStore } from "../../agents/cli-session-store.js";
import { resolveMemorySearchConfig } from "../../agents/memory-search.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { readSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { resolveStateDir } from "../../config/state-dir.js";
import { createEmbeddingProvider } from "../../plugin-sdk/memory-core-bundled-runtime.js";
import {
  cosineSimilarity,
  findForgetCandidates,
  markEntriesForgotten,
  rankByCloseness,
  type Closeness,
  type ForgetCandidate,
  type ForgetEmbedder,
  type ForgetTarget,
} from "../../sessions/topic-forget-fork.js";
import {
  findForgetGitCommits,
  gitFoldersOfChat,
  resolveGitRepositories,
  type ForgetGitCommit,
  type ForgetGitRepository,
} from "../../sessions/topic-forget-git-fork.js";
import {
  collectMemoryParagraphs,
  forgetMemoryParagraphs,
  listMemoryFiles,
} from "../../sessions/topic-forget-memory-fork.js";
import { resolveRequestedSessionStoreTarget } from "../session-store-key.js";
import type { GatewayRequestHandlers } from "./types.js";

/**
 * Fork (N11): forget a topic in a chat.
 * `chat.forget.find { sessionKey, agentId?, topic }` ranks the chat's turns against the topic
 * with the local embedding model memory search uses; no chat model sees the request.
 * `chat.forget.apply { sessionKey, agentId?, topic, entryIds }` marks the ticked rows forgotten
 * (out of every model context, still visible) and drops the chat's Claude CLI binding, so the
 * next turn starts a fresh native session from the filtered history. The agent's memory files
 * (workspace MEMORY.md and memory/**, `memorySearch.extraPaths`) are ranked the same way, and the
 * ticked paragraphs are removed, since memory search would bring the topic back.
 */
const Topic = Type.String({ minLength: 1, maxLength: 500 });
const FindParams = Type.Object(
  {
    sessionKey: Type.String({ minLength: 1, maxLength: 512 }),
    agentId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    topic: Topic,
  },
  { additionalProperties: false },
);
const ApplyParams = Type.Object(
  {
    sessionKey: Type.String({ minLength: 1, maxLength: 512 }),
    agentId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    topic: Topic,
    entryIds: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { maxItems: 5_000 }),
    memory: Type.Optional(
      Type.Array(
        Type.Object(
          {
            file: Type.String({ minLength: 1, maxLength: 4_096 }),
            hash: Type.String({ minLength: 1, maxLength: 64 }),
          },
          { additionalProperties: false },
        ),
        { maxItems: 3_000 },
      ),
    ),
  },
  { additionalProperties: false },
);

export type ChatForgetMemoryCandidate = Closeness & {
  id: string;
  file: string;
  hash: string;
  preview: string;
};
export type ChatForgetFindResult = {
  candidates: ForgetCandidate[];
  memory: ChatForgetMemoryCandidate[];
  /** Fork (N15): commit messages of the repositories the chat's model worked in. */
  git?: { repositories: ForgetGitRepository[]; commits: ForgetGitCommit[] };
};
export type ChatForgetApplyResult = {
  forgotten: string[];
  cliSessionsReset: number;
  memoryRemoved: number;
  memoryFilesDeleted: number;
};

type Deps = {
  readEntry: typeof readSessionEntryReadOnlyInWorker;
  find: typeof findForgetCandidates;
  mark: typeof markEntriesForgotten;
  clearCli: typeof clearCliSessionInStore;
  createEmbedder: (params: { cfg: unknown; agentId: string }) => Promise<ForgetEmbedder>;
  memoryFiles: (params: { cfg: unknown; agentId: string }) => Promise<string[]>;
  forgetMemory: typeof forgetMemoryParagraphs;
  backupDir: () => string;
  findGit: (params: {
    target: ForgetTarget;
    workingFolders: readonly (string | undefined)[];
    topic: string;
    embedder: ForgetEmbedder;
  }) => Promise<NonNullable<ChatForgetFindResult["git"]>>;
};

async function findChatGitCommits(params: {
  target: ForgetTarget;
  workingFolders: readonly (string | undefined)[];
  topic: string;
  embedder: ForgetEmbedder;
}): Promise<NonNullable<ChatForgetFindResult["git"]>> {
  const entries = await loadCliSessionEntries({ sessionTarget: params.target });
  const repositories = await resolveGitRepositories(
    gitFoldersOfChat(entries, params.workingFolders),
  );
  const commits = await findForgetGitCommits({
    repositories,
    topic: params.topic,
    embedder: params.embedder,
  });
  return { repositories, commits };
}

async function agentMemoryFiles(params: { cfg: unknown; agentId: string }): Promise<string[]> {
  const cfg = params.cfg as Parameters<typeof resolveAgentWorkspaceDir>[0];
  return listMemoryFiles({
    workspaceDir: resolveAgentWorkspaceDir(cfg, params.agentId),
    extraPaths: (resolveMemorySearchConfig(cfg, params.agentId)?.extraPaths ?? []).map((extra) =>
      typeof extra === "string" ? extra : extra.path,
    ),
  });
}

/** Memory paragraphs ranked against the topic. */
async function findMemoryCandidates(
  files: readonly string[],
  topic: string,
  embedder: ForgetEmbedder,
): Promise<ChatForgetMemoryCandidate[]> {
  const paragraphs = await collectMemoryParagraphs(files);
  if (paragraphs.length === 0) {
    return [];
  }
  const [query, vectors] = await Promise.all([
    embedder.embedQuery(topic),
    embedder.embedDocuments(paragraphs.map((paragraph) => paragraph.text)),
  ]);
  const ranked = rankByCloseness(
    paragraphs.map((paragraph) => paragraph.text),
    vectors.map((vector) => cosineSimilarity(query, vector)),
    topic,
  );
  const candidates: ChatForgetMemoryCandidate[] = [];
  paragraphs.forEach(({ text: _text, ...paragraph }, index) => {
    candidates.push(Object.assign(paragraph, ranked[index]!));
  });
  return candidates.toSorted((left, right) => right.score - left.score).slice(0, 200);
}

async function createLocalEmbedder(params: {
  cfg: unknown;
  agentId: string;
}): Promise<ForgetEmbedder> {
  const cfg = params.cfg as Parameters<typeof resolveAgentDir>[0];
  // The embedding model memory search is configured with (memory.search.provider, e.g. "local"
  // for llama.cpp), never a bare "auto": "auto" resolves to OpenAI, which would send the chat
  // to a remote API, or fail without a key.
  const settings = resolveMemorySearchConfig(cfg, params.agentId);
  if (!settings) {
    throw new Error(
      "Memory search is off for this agent; Forget a topic ranks with its embedding model.",
    );
  }
  const result = await createEmbeddingProvider({
    config: cfg,
    agentDir: resolveAgentDir(cfg, params.agentId),
    provider: settings.provider,
    model: settings.model,
    fallback: settings.fallback,
    ...(settings.remote ? { remote: settings.remote } : {}),
    ...(settings.local ? { local: settings.local } : {}),
    ...(settings.outputDimensionality
      ? { outputDimensionality: settings.outputDimensionality }
      : {}),
  });
  const provider = result.provider;
  if (!provider) {
    throw new Error(result.providerUnavailableReason ?? "No embedding model is available.");
  }
  return {
    embedQuery: async (text) => (await provider.embedBatch([text], { inputType: "query" }))[0]!,
    embedDocuments: (texts) => provider.embedBatch(texts, { inputType: "document" }),
  };
}

const sanitizeTopic = (topic: string) => topic.replace(/[\p{Cc}\s]+/gu, " ").trim();

export function createChatForgetHandlers(deps: Partial<Deps> = {}): GatewayRequestHandlers {
  const readEntry = deps.readEntry ?? readSessionEntryReadOnlyInWorker;
  const find = deps.find ?? findForgetCandidates;
  const mark = deps.mark ?? markEntriesForgotten;
  const clearCli = deps.clearCli ?? clearCliSessionInStore;
  const createEmbedder = deps.createEmbedder ?? createLocalEmbedder;
  const memoryFiles = deps.memoryFiles ?? agentMemoryFiles;
  const forgetMemory = deps.forgetMemory ?? forgetMemoryParagraphs;
  const findGit = deps.findGit ?? findChatGitCommits;
  const backupDir =
    deps.backupDir ??
    (() =>
      path.join(resolveStateDir(), "forget-backups", new Date().toISOString().replace(/:/g, "-")));
  const fail = (
    respond: Parameters<GatewayRequestHandlers[string]>[0]["respond"],
    error: unknown,
  ) =>
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.UNAVAILABLE,
        error instanceof Error ? error.message : "The chat could not be read.",
      ),
    );
  async function resolveTarget(
    context: Parameters<GatewayRequestHandlers[string]>[0]["context"],
    params: { sessionKey: string; agentId?: string },
  ) {
    const cfg = context.getRuntimeConfig();
    const requested = resolveRequestedSessionStoreTarget(cfg, params.sessionKey, params.agentId);
    if (!requested.ok) {
      return { ok: false as const, error: requested.error };
    }
    const { agentId, sessionKey } = requested.value;
    const storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId });
    const entry = await readEntry({ agentId, sessionKey, storePath });
    const target: ForgetTarget | undefined = entry?.sessionId
      ? { agentId, sessionId: entry.sessionId, sessionKey, storePath }
      : undefined;
    return { ok: true as const, cfg, agentId, sessionKey, storePath, entry, target };
  }
  return {
    "chat.forget.find": async ({ params, respond, context }) => {
      if (!Value.Check(FindParams, params)) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "chat.forget.find expects { sessionKey, agentId?, topic }",
          ),
        );
        return;
      }
      try {
        const resolved = await resolveTarget(context, params);
        if (!resolved.ok) {
          respond(false, undefined, resolved.error);
          return;
        }
        const topic = sanitizeTopic(params.topic);
        const embedder = await createEmbedder({ cfg: resolved.cfg, agentId: resolved.agentId });
        const candidates = resolved.target
          ? await find({ target: resolved.target, topic, embedder })
          : [];
        const memory = await findMemoryCandidates(
          await memoryFiles({ cfg: resolved.cfg, agentId: resolved.agentId }),
          topic,
          embedder,
        );
        // The repositories the chat's model worked in: its working folder and git commands.
        const git = resolved.target
          ? await findGit({
              target: resolved.target,
              workingFolders: [
                resolved.entry?.spawnedCwd,
                resolveAgentWorkspaceDir(
                  resolved.cfg as Parameters<typeof resolveAgentWorkspaceDir>[0],
                  resolved.agentId,
                ),
              ],
              topic,
              embedder,
            }).catch((error: unknown) => {
              context.logGateway.warn(
                `chat forget git search failed: session=${params.sessionKey}: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              );
              return undefined;
            })
          : undefined;
        const response: ChatForgetFindResult = { candidates, memory, ...(git ? { git } : {}) };
        respond(true, response);
      } catch (error) {
        context.logGateway.warn(
          `chat forget find failed: session=${params.sessionKey}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        fail(respond, error);
      }
    },
    "chat.forget.apply": async ({ params, respond, context, sessionMutationAuthorization }) => {
      if (
        !Value.Check(ApplyParams, params) ||
        (params.entryIds.length === 0 && !params.memory?.length)
      ) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "chat.forget.apply expects { sessionKey, agentId?, topic, entryIds, memory? }",
          ),
        );
        return;
      }
      try {
        const resolved = await resolveTarget(context, params);
        if (!resolved.ok) {
          respond(false, undefined, resolved.error);
          return;
        }
        sessionMutationAuthorization?.assertCurrent();
        const topic = sanitizeTopic(params.topic);
        const forgotten =
          resolved.target && params.entryIds.length > 0
            ? await mark({ target: resolved.target, entryIds: params.entryIds, topic })
            : [];
        const memoryResult = params.memory?.length
          ? await forgetMemory({
              // Only files memory search reads for this agent can be changed.
              allowedFiles: await memoryFiles({ cfg: resolved.cfg, agentId: resolved.agentId }),
              picks: params.memory,
              backupDir: backupDir(),
            })
          : { removed: 0, deletedFiles: [] };
        let cliSessionsReset = 0;
        const entry = resolved.entry;
        if (forgotten.length > 0 && entry) {
          // A resumed native session still holds the topic: drop every CLI binding.
          const providers = new Set([
            ...Object.keys(entry.cliSessionBindings ?? {}),
            ...Object.keys(entry.cliSessionIds ?? {}),
            ...(entry.claudeCliSessionId ? ["claude-cli"] : []),
          ]);
          for (const provider of providers) {
            await clearCli({
              agentId: resolved.agentId,
              provider,
              sessionKey: resolved.sessionKey,
              storePath: resolved.storePath,
              activeSessionEntry: structuredClone(entry),
            });
            cliSessionsReset += 1;
          }
        }
        context.logGateway.info(
          `chat forget: session=${resolved.sessionKey} topic=${JSON.stringify(topic)} ` +
            `forgotten=${forgotten.length}/${params.entryIds.length} cliReset=${cliSessionsReset} ` +
            `memoryRemoved=${memoryResult.removed} memoryFilesDeleted=${memoryResult.deletedFiles.length}`,
        );
        const response: ChatForgetApplyResult = {
          forgotten,
          cliSessionsReset,
          memoryRemoved: memoryResult.removed,
          memoryFilesDeleted: memoryResult.deletedFiles.length,
        };
        respond(true, response);
      } catch (error) {
        context.logGateway.warn(
          `chat forget failed: session=${params.sessionKey}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        fail(respond, error);
      }
    },
  };
}

export const chatForgetHandlers = createChatForgetHandlers();
