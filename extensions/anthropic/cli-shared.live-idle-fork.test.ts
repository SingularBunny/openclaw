import { describe, expect, it } from "vitest";
import { normalizeClaudeBackendConfig } from "./cli-shared.js";

const withIdle = (value: unknown) =>
  normalizeClaudeBackendConfig({ command: "claude" }, {
    config: { plugins: { entries: { anthropic: { config: { liveSessionIdleMinutes: value } } } } },
  } as never);

describe("Claude process idle lifetime", () => {
  it("turns the plugin's minutes into the backend's idle lifetime", () => {
    expect(withIdle(480).liveSessionIdleMs).toBe(480 * 60_000);
    expect(withIdle(5000).liveSessionIdleMs).toBe(1440 * 60_000);
  });

  it("keeps upstream's default without a valid setting", () => {
    expect(withIdle(undefined).liveSessionIdleMs).toBeUndefined();
    expect(withIdle(0).liveSessionIdleMs).toBeUndefined();
    expect(withIdle("60").liveSessionIdleMs).toBeUndefined();
    expect(normalizeClaudeBackendConfig({ command: "claude" }).liveSessionIdleMs).toBeUndefined();
  });
});
