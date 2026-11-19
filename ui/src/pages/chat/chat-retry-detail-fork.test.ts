import { describe, expect, it } from "vitest";
import { chatRetryDetailLabel, readChatRetryDetail } from "./chat-retry-detail-fork.ts";
import { chatStartupStatusLabel } from "./chat-run-startup.ts";

describe("retry detail next to Retrying… (F89)", () => {
  it("reads the attempt and the reason the Gateway sent", () => {
    expect(readChatRetryDetail({ attempt: 3, maxAttempts: 10, reason: "overloaded" })).toEqual({
      attempt: 3,
      maxAttempts: 10,
      reason: "overloaded",
    });
    expect(readChatRetryDetail({ reason: "unknown", attempt: 0 })).toBeUndefined();
    expect(readChatRetryDetail(undefined)).toBeUndefined();
  });

  it("words it for the chat", () => {
    expect(chatRetryDetailLabel({ attempt: 3, maxAttempts: 10, reason: "overloaded" })).toBe(
      "attempt 3 of 10 · model overloaded",
    );
    expect(chatRetryDetailLabel({ attempt: 2 })).toBe("attempt 2");
    expect(chatRetryDetailLabel({ reason: "timeout" })).toBe("no response");
  });

  it("the startup label carries it while the turn retries", () => {
    expect(
      chatStartupStatusLabel(
        {
          state: "status",
          runId: "r",
          phase: "retrying",
          seq: 1,
          detail: { attempt: 4, maxAttempts: 10, reason: "rate_limit" },
        },
        undefined,
      ),
    ).toBe("Retrying… attempt 4 of 10 · rate limit");
    expect(
      chatStartupStatusLabel({ state: "status", runId: "r", phase: "retrying", seq: 1 }, undefined),
    ).toBe("Retrying…");
  });
});
