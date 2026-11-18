import { expect, it } from "vitest";
import { resolveSessionDisplayName } from "./session-display.ts";

const HASH = "6f1c0d2e9a7b4c3d8e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d";

it("names an untitled continued Claude Code chat after its source, not its key", () => {
  const key = `agent:main:plugin:anthropic:catalog-adopt:claude:${HASH}`;
  expect(resolveSessionDisplayName(key)).toBe("Claude Code chat");
  expect(resolveSessionDisplayName(key, { key, derivedTitle: "Fix the build" } as never)).toBe(
    "Fix the build",
  );
});

it("covers the other catalog sources and leaves ordinary keys alone", () => {
  expect(resolveSessionDisplayName(`agent:main:plugin:acpx:catalog-adopt:pi:${HASH}`)).toBe(
    "Pi chat",
  );
  expect(resolveSessionDisplayName(`agent:main:plugin:opencode:catalog-adopt:${HASH}`)).toBe(
    "OpenCode chat",
  );
  expect(resolveSessionDisplayName("agent:main:my-notes")).toBe("my-notes");
});
