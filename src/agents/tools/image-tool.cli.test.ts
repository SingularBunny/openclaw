import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

// Fork: an image model on a CLI runtime (Claude by subscription) is asked through one isolated CLI turn.
const cli = vi.hoisted(() => ({
  route: vi.fn(),
  complete: vi.fn(),
}));
vi.mock("./media-tool-cli.js", () => ({
  MEDIA_TOOL_CLI_TIMEOUT_MS: 180_000,
  resolveMediaToolCliRoute: cli.route,
}));
vi.mock("../isolated-completion.js", () => ({ runIsolatedCompletion: cli.complete }));

const { runImagePrompt } = await import("./image-tool.model-execution.js");

const cfg: OpenClawConfig = {
  plugins: { enabled: false },
  agents: { defaults: { imageModel: { primary: "anthropic/claude-haiku-5-5" } } },
};

describe("image tool on a CLI runtime", () => {
  beforeEach(() => {
    cli.route.mockReset();
    cli.complete.mockReset();
  });

  it("sends the prompt and every image as base64 in one isolated CLI turn", async () => {
    cli.route.mockResolvedValue({ provider: "anthropic", cliOwner: "claude-cli", agentId: "main" });
    cli.complete.mockResolvedValue({
      text: "a cat",
      provider: "anthropic",
      model: "claude-haiku-5-5",
    });
    const result = await runImagePrompt({
      cfg,
      agentDir: "/agents/main",
      imageModelConfig: { primary: "anthropic/claude-haiku-5-5" },
      prompt: "What is on it?",
      images: [
        { buffer: Buffer.from("one"), mimeType: "image/png" },
        { buffer: Buffer.from("two"), mimeType: "image/jpeg" },
      ],
    });
    expect(result).toMatchObject({
      text: "a cat",
      provider: "anthropic",
      model: "claude-haiku-5-5",
    });
    expect(cli.complete).toHaveBeenCalledTimes(1);
    const request = cli.complete.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      provider: "anthropic",
      model: "claude-haiku-5-5",
      agentHarnessRuntimeOverride: "claude-cli",
      prompt: "What is on it?",
      images: [
        { type: "image", data: Buffer.from("one").toString("base64"), mimeType: "image/png" },
        { type: "image", data: Buffer.from("two").toString("base64"), mimeType: "image/jpeg" },
      ],
    });
  });
});
