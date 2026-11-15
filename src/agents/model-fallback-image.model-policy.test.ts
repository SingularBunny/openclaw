import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runWithImageModelFallback } from "./model-fallback-image.js";
import { resolvePromptAndModelOverride } from "./tools/media-tool-shared.js";

// Fork: the model an agent names in the image or pdf tool obeys agents.defaults.modelPolicy.allow,
// and OPENCLAW_MEDIA_MODEL_OVERRIDE=0 drops it.
function config(allow?: string[]): OpenClawConfig {
  return {
    plugins: { enabled: false },
    agents: {
      entries: { main: {} },
      defaults: {
        model: "test-provider/chat",
        imageModel: { primary: "test-provider/vision", fallbacks: ["other-provider/backup"] },
        modelPolicy: allow ? { allow } : {},
      },
    },
  };
}

describe("model allowlist on the model an agent names for image and pdf", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("rejects a named model outside the allowlist without calling a provider", async () => {
    const run = vi.fn();
    await expect(
      runWithImageModelFallback({
        cfg: config(["test-provider/chat", "test-provider/vision"]),
        manifestPlugins: [],
        modelOverride: "paid-provider/expensive",
        run,
      }),
    ).rejects.toThrow("not in the model allowlist");
    expect(run).not.toHaveBeenCalled();
  });

  it("lets a named model in by exact ref or provider wildcard", async () => {
    for (const allow of [["paid-provider/expensive"], ["paid-provider/*"]]) {
      const run = vi.fn().mockResolvedValue("answer");
      await expect(
        runWithImageModelFallback({
          cfg: config(allow),
          manifestPlugins: [],
          modelOverride: "paid-provider/expensive",
          run,
        }),
      ).resolves.toMatchObject({ result: "answer", model: "expensive" });
    }
  });

  it("lets the agent name a configured image model outside the allowlist", async () => {
    const run = vi.fn().mockResolvedValue("answer");
    await expect(
      runWithImageModelFallback({
        cfg: config(["test-provider/chat"]),
        manifestPlugins: [],
        modelOverride: "other-provider/backup",
        run,
      }),
    ).resolves.toMatchObject({ model: "backup" });
  });

  it("keeps configured image models reachable and leaves an empty policy unrestricted", async () => {
    const configured = vi.fn().mockResolvedValue("answer");
    await expect(
      runWithImageModelFallback({
        cfg: config(["test-provider/chat"]),
        manifestPlugins: [],
        run: configured,
      }),
    ).resolves.toMatchObject({ model: "vision" });
    const any = vi.fn().mockResolvedValue("answer");
    await expect(
      runWithImageModelFallback({
        cfg: config(),
        manifestPlugins: [],
        modelOverride: "paid-provider/expensive",
        run: any,
      }),
    ).resolves.toMatchObject({ model: "expensive" });
  });

  it("drops the named model when OPENCLAW_MEDIA_MODEL_OVERRIDE is off", () => {
    expect(
      resolvePromptAndModelOverride({ model: "paid-provider/expensive" }, "p").modelOverride,
    ).toBe("paid-provider/expensive");
    vi.stubEnv("OPENCLAW_MEDIA_MODEL_OVERRIDE", "0");
    expect(
      resolvePromptAndModelOverride({ model: "paid-provider/expensive", prompt: "q" }, "p"),
    ).toEqual({
      prompt: "q",
      modelOverride: undefined,
    });
  });
});
