import { describe, expect, it } from "vitest";
import {
  CLAUDE_LOGIN_EXPIRED_PUSH_INTERVAL_MS,
  CLAUDE_LOGIN_EXPIRED_PUSH_TAG,
  createClaudeLoginExpiredPushGate,
  resolveClaudeLoginExpiredWebPush,
} from "./event-web-push-claude-login-fork.js";

const HINT =
  "Claude subscription login expired: Claude Code on the Gateway can no longer use your Claude account. Run `claude auth login` in a terminal on the Gateway host, sign in, then try again.";

describe("Claude login expired Web Push", () => {
  it("recognises a failed automation run by its error", () => {
    const push = resolveClaudeLoginExpiredWebPush("cron", {
      action: "finished",
      status: "error",
      jobId: "nightly-report",
      error: "claude-cli: OAuth session expired and could not be refreshed. Please run /login.",
    });
    expect(push).toMatchObject({
      category: "scheduled-task-failed",
      title: "Claude login expired",
      tag: CLAUDE_LOGIN_EXPIRED_PUSH_TAG,
      path: "automations",
    });
  });

  it("recognises a chat error and a chat reply that opens with the hint", () => {
    expect(
      resolveClaudeLoginExpiredWebPush("chat", { state: "error", errorMessage: HINT }),
    ).toMatchObject({ category: "agent-finished", tag: CLAUDE_LOGIN_EXPIRED_PUSH_TAG });
    expect(
      resolveClaudeLoginExpiredWebPush("chat", {
        state: "final",
        message: { role: "assistant", content: [{ type: "text", text: `⚠️ ${HINT}` }] },
      }),
    ).toMatchObject({ category: "agent-finished" });
  });

  it("ignores replies that only quote the phrase and other failures", () => {
    expect(
      resolveClaudeLoginExpiredWebPush("chat", {
        state: "final",
        message: { content: [{ type: "text", text: `The log said: ${HINT}` }] },
      }),
    ).toBeNull();
    expect(
      resolveClaudeLoginExpiredWebPush("cron", {
        action: "finished",
        status: "error",
        error: "timeout",
        summary: HINT,
      }),
    ).toBeNull();
    expect(
      resolveClaudeLoginExpiredWebPush("cron", { action: "finished", status: "ok", error: HINT }),
    ).toBeNull();
    expect(
      resolveClaudeLoginExpiredWebPush("chat", {
        state: "error",
        errorMessage: "OpenRouter: 401 invalid authentication credentials",
      }),
    ).toBeNull();
  });

  it("sends the first notice, then at most one per interval", () => {
    let now = 1_000;
    const gate = createClaudeLoginExpiredPushGate(() => now);
    expect(gate()).toBe(true);
    now += 60_000;
    expect(gate()).toBe(false);
    now += CLAUDE_LOGIN_EXPIRED_PUSH_INTERVAL_MS;
    expect(gate()).toBe(true);
  });
});
