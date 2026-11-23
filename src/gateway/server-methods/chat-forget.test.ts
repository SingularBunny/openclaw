import { describe, expect, it, vi } from "vitest";

const embeddings = vi.hoisted(() => ({ create: vi.fn() }));
// mock-isolation: observe which embedding model the ranking asks for, without loading one.
vi.mock("../../plugin-sdk/memory-core-bundled-runtime.js", () => ({
  createEmbeddingProvider: embeddings.create,
}));
import { FORGET_EMBED_BATCH } from "../../sessions/topic-forget-fork.js";
import { createChatForgetHandlers } from "./chat-forget.js";

function call(
  handlers: ReturnType<typeof createChatForgetHandlers>,
  method: string,
  params: Record<string, unknown>,
  cfg: Record<string, unknown> = {},
) {
  const respond = vi.fn();
  const context = {
    getRuntimeConfig: () => cfg,
    logGateway: { info: vi.fn(), warn: vi.fn() },
  };
  return handlers[method]!({ params, respond, context } as never).then(() => ({
    respond,
    context,
  }));
}

describe("chat.forget (N11)", () => {
  const entry = {
    sessionId: "s1",
    cliSessionBindings: { "claude-cli": { sessionId: "native-1" } },
  };

  it("ranks with the local embedder and never calls a chat model", async () => {
    const find = vi.fn(async () => [
      {
        id: "u1",
        entryIds: ["u1"],
        preview: "p",
        beforeSummary: false,
        score: 0.9,
        literal: true,
        selected: true,
      },
    ]);
    const embedder = { embedQuery: vi.fn(), embedDocuments: vi.fn() };
    const handlers = createChatForgetHandlers({
      readEntry: vi.fn(async () => entry) as never,
      find: find as never,
      createEmbedder: async () => embedder,
      memoryFiles: async () => [],
      findGit: async () => ({ repositories: [], commits: [] }),
    });
    const { respond } = await call(handlers, "chat.forget.find", {
      sessionKey: "agent:main:main",
      topic: "  taxes\n",
    });
    expect(find).toHaveBeenCalledWith(expect.objectContaining({ topic: "taxes", embedder }));
    expect(respond).toHaveBeenCalledWith(true, {
      candidates: expect.any(Array),
      memory: [],
      git: { repositories: [], commits: [] },
    });
  });

  it("ranks with the embedding model memory search is configured with, not OpenAI by default", async () => {
    const provider = { embedBatch: vi.fn(async (texts: string[]) => texts.map(() => [1, 0])) };
    embeddings.create.mockResolvedValue({ provider, requestedProvider: "local" });
    const find = vi.fn(async ({ embedder }: { embedder: { embedQuery(t: string): unknown } }) => {
      await embedder.embedQuery("taxes");
      return [];
    });
    const handlers = createChatForgetHandlers({
      readEntry: vi.fn(async () => entry) as never,
      find: find as never,
      memoryFiles: async () => [],
      findGit: async () => ({ repositories: [], commits: [] }),
    });
    const { respond } = await call(
      handlers,
      "chat.forget.find",
      { sessionKey: "agent:main:main", topic: "taxes" },
      { memory: { search: { provider: "local" } } },
    );
    expect(respond).toHaveBeenCalledWith(true, {
      candidates: [],
      memory: [],
      git: { repositories: [], commits: [] },
    });
    expect(embeddings.create).toHaveBeenCalledWith(expect.objectContaining({ provider: "local" }));
    expect(embeddings.create).not.toHaveBeenCalledWith(
      expect.objectContaining({ provider: "auto" }),
    );
    expect(provider.embedBatch).toHaveBeenCalledWith(["taxes"], { inputType: "query" });
  });

  it("says why the commit search failed instead of dropping the git section", async () => {
    const handlers = createChatForgetHandlers({
      readEntry: vi.fn(async () => entry) as never,
      createEmbedder: async () => ({ embedQuery: vi.fn(), embedDocuments: vi.fn() }),
      find: (async () => []) as never,
      memoryFiles: async () => [],
      findGit: async () => {
        throw new Error("llama-cpp embeddings failed: JSON response too big; stderr: noise\nmore");
      },
    });
    const { respond } = await call(handlers, "chat.forget.find", {
      sessionKey: "agent:main:main",
      topic: "taxes",
    });
    expect(respond).toHaveBeenCalledWith(true, {
      candidates: [],
      memory: [],
      git: {
        repositories: [],
        commits: [],
        error: "llama-cpp embeddings failed: JSON response too big",
      },
    });
  });

  // Live 23.11.2026: 1071 commit messages in one request made llama.cpp's answer exceed 16 MB,
  // and the git section silently vanished from the dialog.
  it("embeds many documents in batches, in order", async () => {
    const provider = {
      embedBatch: vi.fn(async (texts: string[]) => texts.map((text) => [Number(text), 0])),
    };
    embeddings.create.mockResolvedValue({ provider, requestedProvider: "local" });
    const texts = Array.from({ length: 1071 }, (_, index) => String(index));
    let vectors: number[][] = [];
    const handlers = createChatForgetHandlers({
      readEntry: vi.fn(async () => entry) as never,
      find: (async ({
        embedder,
      }: {
        embedder: { embedDocuments(t: string[]): Promise<number[][]> };
      }) => {
        vectors = await embedder.embedDocuments(texts);
        return [];
      }) as never,
      memoryFiles: async () => [],
      findGit: async () => ({ repositories: [], commits: [] }),
    });
    await call(
      handlers,
      "chat.forget.find",
      { sessionKey: "agent:main:main", topic: "taxes" },
      { memory: { search: { provider: "local" } } },
    );
    const sizes = provider.embedBatch.mock.calls.map(([batch]) => batch.length);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(FORGET_EMBED_BATCH);
    expect(sizes.reduce((sum, size) => sum + size, 0)).toBe(1071);
    expect(vectors.map(([first]) => first)).toEqual(texts.map(Number));
  });

  it("marks the rows forgotten and drops the Claude CLI binding", async () => {
    const mark = vi.fn(async () => ["u1", "a1"]);
    const clearCli = vi.fn(async () => undefined);
    const handlers = createChatForgetHandlers({
      readEntry: vi.fn(async () => entry) as never,
      mark: mark as never,
      clearCli: clearCli as never,
    });
    const { respond } = await call(handlers, "chat.forget.apply", {
      sessionKey: "agent:main:main",
      topic: "taxes",
      entryIds: ["u1", "a1"],
    });
    expect(mark).toHaveBeenCalledWith(
      expect.objectContaining({ entryIds: ["u1", "a1"], topic: "taxes" }),
    );
    expect(clearCli).toHaveBeenCalledWith(expect.objectContaining({ provider: "claude-cli" }));
    expect(respond).toHaveBeenCalledWith(true, {
      forgotten: ["u1", "a1"],
      cliSessionsReset: 1,
      memoryRemoved: 0,
      memoryFilesDeleted: 0,
    });
  });

  it("rejects malformed requests", async () => {
    const handlers = createChatForgetHandlers();
    const { respond } = await call(handlers, "chat.forget.apply", {
      sessionKey: "k",
      topic: "t",
      entryIds: [],
    });
    expect(respond.mock.calls[0]![0]).toBe(false);
  });

  it("removes ticked memory paragraphs only from the agent's memory files", async () => {
    const forgetMemory = vi.fn(async () => ({ removed: 1, deletedFiles: [] }));
    const handlers = createChatForgetHandlers({
      readEntry: vi.fn(async () => entry) as never,
      memoryFiles: async () => ["/w/MEMORY.md"],
      forgetMemory: forgetMemory as never,
      backupDir: () => "/b",
    });
    const { respond } = await call(handlers, "chat.forget.apply", {
      sessionKey: "agent:main:main",
      topic: "taxes",
      entryIds: [],
      memory: [{ file: "/w/MEMORY.md", hash: "h1" }],
    });
    expect(forgetMemory).toHaveBeenCalledWith({
      allowedFiles: ["/w/MEMORY.md"],
      picks: [{ file: "/w/MEMORY.md", hash: "h1" }],
      backupDir: "/b",
    });
    expect(respond).toHaveBeenCalledWith(true, expect.objectContaining({ memoryRemoved: 1 }));
  });

  describe("git (N15)", () => {
    const repoWith = async (messages: string[]) => {
      const { execFileSync } = await import("node:child_process");
      const fs = await import("node:fs");
      const os = await import("node:os");
      const path = await import("node:path");
      const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "forget-git-handler-")));
      const env = {
        ...process.env,
        GIT_AUTHOR_NAME: "O",
        GIT_AUTHOR_EMAIL: "o@example.test",
        GIT_COMMITTER_NAME: "O",
        GIT_COMMITTER_EMAIL: "o@example.test",
      };
      execFileSync("git", ["-C", dir, "init", "-q"], { env });
      for (const message of messages) {
        execFileSync("git", ["-C", dir, "commit", "-q", "--allow-empty", "-m", message], { env });
      }
      const head = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim();
      return { dir, head, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
    };

    it("rewrites only commits of the chat's repositories, with the topic redacted", async () => {
      const repo = await repoWith(["Plan\n\nFiled the taxes return"]);
      try {
        const rewriteGit = vi.fn(async (params: { repo: string }) => ({
          repo: params.repo,
          rewritten: 1,
          backup: "/b",
          push: [],
        }));
        const handlers = createChatForgetHandlers({
          readEntry: vi.fn(async () => entry) as never,
          chatRepositories: async () => [{ root: repo.dir, remotes: [] }],
          rewriteGit: rewriteGit as never,
          backupDir: () => "/tmp/forget-backups-test",
        });
        const outside = await call(handlers, "chat.forget.git.apply", {
          sessionKey: "agent:main:main",
          topic: "taxes",
          commits: [{ repo: "/elsewhere", hash: repo.head }],
        });
        expect(outside.respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({
            message: "/elsewhere is not a repository this chat worked in",
          }),
        );
        expect(rewriteGit).not.toHaveBeenCalled();

        const { respond } = await call(handlers, "chat.forget.git.apply", {
          sessionKey: "agent:main:main",
          topic: "taxes",
          commits: [{ repo: repo.dir, hash: repo.head }],
        });
        expect(rewriteGit).toHaveBeenCalledWith(
          expect.objectContaining({
            repo: repo.dir,
            rewrites: [{ repo: repo.dir, hash: repo.head, message: "Plan\n\n[removed]\n" }],
          }),
        );
        expect(respond).toHaveBeenCalledWith(true, {
          repositories: [{ repo: repo.dir, rewritten: 1, backup: "/b", push: [] }],
        });
      } finally {
        repo.cleanup();
      }
    });

    it("rewrites with the local model picked in the dialog", async () => {
      const repo = await repoWith(["Plan\n\nFiled the taxes return and fixed the clock"]);
      try {
        const rewriteGit = vi.fn(async (params: { repo: string }) => ({
          repo: params.repo,
          rewritten: 1,
          backup: "/b",
          push: [],
        }));
        const createRewriter = vi.fn(async () => async () => "Fixed the clock");
        const handlers = createChatForgetHandlers({
          readEntry: vi.fn(async () => entry) as never,
          chatRepositories: async () => [{ root: repo.dir, remotes: [] }],
          rewriteGit: rewriteGit as never,
          createRewriter: createRewriter as never,
          backupDir: () => "/tmp/forget-backups-test",
        });
        await call(handlers, "chat.forget.git.apply", {
          sessionKey: "agent:main:main",
          topic: "taxes",
          commits: [{ repo: repo.dir, hash: repo.head }],
          rewriteModel: "llama-cpp/gemma-4-e4b-it-q4_k_m",
        });
        expect(createRewriter).toHaveBeenCalledWith(
          expect.objectContaining({ modelRef: "llama-cpp/gemma-4-e4b-it-q4_k_m" }),
        );
        expect(rewriteGit).toHaveBeenCalledWith(
          expect.objectContaining({
            rewrites: [{ repo: repo.dir, hash: repo.head, message: "Plan\n\nFixed the clock\n" }],
          }),
        );
      } finally {
        repo.cleanup();
      }
    });

    it("pushes only confirmed branches of the chat's repositories", async () => {
      const pushGit = vi.fn(async () => undefined);
      const handlers = createChatForgetHandlers({
        readEntry: vi.fn(async () => entry) as never,
        chatRepositories: async () => [{ root: "/repo/a", remotes: [] }],
        pushGit: pushGit as never,
      });
      const plan = {
        branch: "main",
        remote: "origin",
        remoteBranch: "main",
        expected: "a".repeat(40),
      };
      const { respond } = await call(handlers, "chat.forget.git.push", {
        sessionKey: "agent:main:main",
        pushes: [
          { repo: "/repo/a", ...plan },
          { repo: "/repo/b", ...plan },
        ],
      });
      expect(pushGit).toHaveBeenCalledTimes(1);
      expect(respond).toHaveBeenCalledWith(true, {
        pushed: ["/repo/a:main"],
        failed: [
          expect.objectContaining({
            repo: "/repo/b",
            error: "not a repository this chat worked in",
          }),
        ],
      });
    });
  });
});
