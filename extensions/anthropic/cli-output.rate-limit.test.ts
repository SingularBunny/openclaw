import { afterEach, describe, expect, it, vi } from "vitest";
import { parseClaudeCliJsonlLifecycleEvent, parseClaudeRateLimitEvent } from "./cli-output.js";

const record = vi.hoisted(() => vi.fn());
vi.mock("openclaw/plugin-sdk/provider-usage", () => ({ recordProviderUsageRateLimit: record }));

const ctx = { backendId: "claude-cli", backend: { command: "claude" } } as Parameters<
  typeof parseClaudeCliJsonlLifecycleEvent
>[1];

describe("Claude CLI rate_limit_event", () => {
  afterEach(() => record.mockReset());

  it("normalizes the stream-json record (resetsAt in seconds)", () => {
    const line = JSON.stringify({
      type: "rate_limit_event",
      rate_limit_info: { status: "rejected", rateLimitType: "five_hour", resetsAt: 1_799_996_400 },
      session_id: "s",
    });
    expect(parseClaudeRateLimitEvent(line)).toEqual({
      status: "rejected",
      limitType: "five_hour",
      resetAt: 1_799_996_400_000,
    });
  });

  it("ignores other records and malformed payloads", () => {
    expect(parseClaudeRateLimitEvent('{"type":"assistant","text":"rate_limit_event"}')).toBeNull();
    expect(
      parseClaudeRateLimitEvent('{"type":"rate_limit_event","rate_limit_info":{}}'),
    ).toBeNull();
    expect(parseClaudeRateLimitEvent("rate_limit_event {")).toBeNull();
  });

  it("records the status without turning the line into a lifecycle event", async () => {
    const line = JSON.stringify({
      type: "rate_limit_event",
      rate_limit_info: { status: "allowed_warning", rateLimitType: "seven_day" },
    });
    expect(parseClaudeCliJsonlLifecycleEvent(line, ctx)).toBeNull();
    await vi.waitFor(() => expect(record).toHaveBeenCalledOnce());
    expect(record).toHaveBeenCalledWith({
      provider: "anthropic",
      status: "allowed_warning",
      limitType: "seven_day",
    });
  });
});
