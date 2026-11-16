import { describe, expect, it } from "vitest";
import { resolveHistoryAuthorLabel } from "./history-author.js";

describe("resolveHistoryAuthorLabel", () => {
  const claude = { provider: "claude-cli", model: "opus" };

  it("labels assistant turns another model or ACP agent wrote", () => {
    expect(
      resolveHistoryAuthorLabel({ role: "assistant", provider: "acp", model: "junie" }, claude),
    ).toBe("junie");
    expect(
      resolveHistoryAuthorLabel(
        { role: "assistant", provider: "openrouter", model: "x/y" },
        claude,
      ),
    ).toBe("openrouter/x/y");
    expect(
      resolveHistoryAuthorLabel(
        { role: "assistant", provider: "claude-cli", model: "opus" },
        { provider: "acp", model: "junie" },
      ),
    ).toBe("claude-cli/opus");
    expect(
      resolveHistoryAuthorLabel(
        { role: "assistant", provider: "acp", model: "codex" },
        { provider: "acp", model: "junie" },
      ),
    ).toBe("codex");
  });

  it("leaves the answering runtime's own turns, user turns and gateway rows unlabelled", () => {
    expect(
      resolveHistoryAuthorLabel(
        { role: "assistant", provider: "claude-cli", model: "sonnet" },
        claude,
      ),
    ).toBeUndefined();
    expect(
      resolveHistoryAuthorLabel(
        { role: "assistant", provider: "acp", model: "junie" },
        { provider: "acp", model: "junie" },
      ),
    ).toBeUndefined();
    expect(
      resolveHistoryAuthorLabel({ role: "user", provider: "acp", model: "junie" }, claude),
    ).toBeUndefined();
    expect(
      resolveHistoryAuthorLabel(
        { role: "assistant", provider: "openclaw", model: "gateway-injected" },
        claude,
      ),
    ).toBeUndefined();
    expect(resolveHistoryAuthorLabel({ role: "assistant" }, claude)).toBeUndefined();
    expect(
      resolveHistoryAuthorLabel({ role: "assistant", provider: "acp", model: "junie" }, undefined),
    ).toBeUndefined();
  });
});
