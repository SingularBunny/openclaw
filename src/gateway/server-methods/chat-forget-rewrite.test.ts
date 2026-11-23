import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  createForgetRewriter,
  forgetRewriteSystemPrompt,
  listLocalRewriteModels,
} from "./chat-forget-rewrite.js";

vi.mock("../../agents/utility-completion.js", () => ({
  prepareUtilityCompletionForAgent: vi.fn(async (params: { modelRef: string }) => ({
    provider: params.modelRef.split("/")[0],
    model: params.modelRef.split("/")[1],
  })),
  runUtilityCompletion: vi.fn(),
}));

const cfg = {
  models: {
    providers: {
      "llama-cpp": {
        baseUrl: "http://127.0.0.1:38221/v1",
        models: [{ id: "gemma-4-e4b-it-q4_k_m" }],
      },
      ollama: { baseUrl: "http://localhost:11434", models: [{ id: "qwen3" }] },
      openrouter: { baseUrl: "https://openrouter.ai/api/v1", models: [{ id: "auto" }] },
    },
  },
} as unknown as OpenClawConfig;

describe("Forget a topic: local rewrite model (N15)", () => {
  it("offers only chat models served from this machine", () => {
    expect(listLocalRewriteModels(cfg)).toEqual([
      "llama-cpp/gemma-4-e4b-it-q4_k_m",
      "ollama/qwen3",
    ]);
    expect(listLocalRewriteModels({} as OpenClawConfig)).toEqual([]);
  });

  it("refuses a remote model, so the topic never leaves the machine", async () => {
    await expect(
      createForgetRewriter({ cfg, agentId: "main", modelRef: "openrouter/auto" }),
    ).rejects.toThrow("not a chat model served from this machine");
  });

  it("asks the model to drop the topic, and reads EMPTY as nothing left", async () => {
    const run = vi.fn(async (request: { prompt: string }) => ({
      text: request.prompt.includes("only taxes") ? "EMPTY" : " Fixed the clock. ",
    }));
    const rewrite = await createForgetRewriter({
      cfg,
      agentId: "main",
      modelRef: "llama-cpp/gemma-4-e4b-it-q4_k_m",
      run: run as never,
    });
    expect(await rewrite("Filed taxes and fixed the clock.", "taxes")).toBe("Fixed the clock.");
    expect(await rewrite("only taxes", "taxes")).toBe("");
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "llama-cpp",
        model: "gemma-4-e4b-it-q4_k_m",
        purpose: "forget-rewrite",
        systemPrompt: forgetRewriteSystemPrompt("taxes"),
        prompt: "Filed taxes and fixed the clock.",
      }),
    );
  });
});
