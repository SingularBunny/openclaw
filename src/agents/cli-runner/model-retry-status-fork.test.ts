import { describe, expect, it } from "vitest";
import { projectChatStatusEvent } from "../../gateway/server-chat-live-text.js";
import { cliModelRetryStatus } from "./model-retry-status-fork.js";

const NOW = 1_800_000_000_000;

describe("Claude CLI model retries in the chat (F89)", () => {
  it("names the attempt, the limit and the reason of an overloaded model", () => {
    const status = cliModelRetryStatus(
      {
        type: "system",
        subtype: "api_retry",
        attempt: 3,
        max_retries: 10,
        retry_delay_ms: 4_200,
        error_status: 529,
        error: "overloaded_error",
      },
      NOW,
    );
    expect(status).toEqual({
      phase: "retrying",
      reason: "overloaded",
      message: "Model request failed (529 overloaded_error). Retry 3 of 10 in 5s.",
      attempt: 3,
      maxAttempts: 10,
      errorStatus: 529,
      error: "overloaded_error",
      delayMs: 4_200,
      retryAt: NOW + 4_200,
    });
  });

  it("reports an unanswered request as a timeout and bounds attempts to the protocol's 10", () => {
    const status = cliModelRetryStatus({
      type: "system",
      subtype: "api_retry",
      attempt: 12,
      max_retries: 15,
      retry_delay_ms: 0,
      error_status: null,
      error: "unknown",
      no_response: { waited_ms: 180_000, retry_wait_ms: 360_000 },
    });
    expect(status).toMatchObject({
      reason: "timeout",
      attempt: 10,
      maxAttempts: 10,
      noResponse: true,
      message: "No response from the model for 180s. Retry 12 of 15.",
    });
    expect(status).not.toHaveProperty("error");
  });

  it("maps rate limits and server errors, and ignores other records", () => {
    const retry = (error_status: number) =>
      cliModelRetryStatus({ type: "system", subtype: "api_retry", attempt: 1, error_status });
    expect(retry(429)?.reason).toBe("rate_limit");
    expect(retry(500)?.reason).toBe("server_error");
    expect(retry(504)?.reason).toBe("timeout");
    expect(cliModelRetryStatus({ type: "system", subtype: "status", status: "requesting" })).toBe(
      undefined,
    );
  });

  it("passes the chat status schema with its attempt and reason", () => {
    const status = cliModelRetryStatus(
      { type: "system", subtype: "api_retry", attempt: 2, max_retries: 10, error_status: 529 },
      NOW,
    )!;
    const payload = projectChatStatusEvent(
      { seq: 7, data: status },
      { runId: "run-1", sessionKey: "agent:main:main" },
    );
    expect(payload).toMatchObject({
      state: "status",
      phase: "starting_model",
      retry: { attempt: 2, maxAttempts: 10, reason: "overloaded" },
    });
  });
});
