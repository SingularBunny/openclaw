import { describe, expect, it, vi } from "vitest";

const embeddings = vi.hoisted(() => ({ create: vi.fn() }));
// mock-isolation: observe which embedding model the ranking asks for, without loading one.
vi.mock("../../plugin-sdk/memory-core-bundled-runtime.js", () => ({
  createEmbeddingProvider: embeddings.create,
}));
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
});
