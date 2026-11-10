import { describe, expect, it } from "vitest";
import type { GatewaySessionRow } from "../../../api/types.ts";
import type { ClaudeUsageView } from "../../../components/claude-usage-indicator-model.ts";
import {
  formatTurnElapsed,
  hasComposerStatusLineParts,
  resolveComposerStatusLine,
} from "./chat-composer-status-line-model.ts";

function session(fields: Partial<GatewaySessionRow>): GatewaySessionRow {
  return { key: "agent:main:main", kind: "direct", updatedAt: 1, ...fields } as GatewaySessionRow;
}

const usage: ClaudeUsageView = {
  rows: [
    { key: "0:5h", label: "5h", percent: 42, resetAt: 9_000_000, tone: "ok" },
    { key: "1:Week", label: "Week", percent: 80, tone: "warn" },
  ],
};

describe("resolveComposerStatusLine", () => {
  it("shows model, context, turn time, Claude 5h limit and permission mode", () => {
    const view = resolveComposerStatusLine({
      session: session({
        model: "claude-opus-4-6",
        modelProvider: "claude-cli",
        totalTokens: 50_000,
        contextTokens: 200_000,
        startedAt: 1_000,
      }),
      runActive: true,
      now: 66_000,
      claudeUsage: usage,
      permissionMode: "workspace",
    });
    expect(view).toMatchObject({
      model: "claude-opus-4-6",
      context: { pct: 25, warning: false },
      turnElapsedMs: 65_000,
      fiveHour: { percent: 42, tone: "ok", resetAt: 9_000_000, reached: false },
      permissionMode: "workspace",
    });
  });

  it("hides unknown parts", () => {
    const view = resolveComposerStatusLine({ now: 0 });
    expect(view).toEqual({});
    expect(hasComposerStatusLineParts(view)).toBe(false);
  });

  it("shows no turn time once the run is over", () => {
    expect(
      resolveComposerStatusLine({
        session: session({ startedAt: 1_000, endedAt: 2_000 }),
        runActive: true,
        now: 5_000,
      }).turnElapsedMs,
    ).toBeUndefined();
    expect(
      resolveComposerStatusLine({ session: session({ startedAt: 1_000 }), now: 5_000 })
        .turnElapsedMs,
    ).toBeUndefined();
  });

  it("leaves the Claude limit out for sessions on other providers", () => {
    expect(
      resolveComposerStatusLine({
        session: session({ model: "gpt-5", modelProvider: "openai" }),
        now: 0,
        claudeUsage: usage,
      }).fiveHour,
    ).toBeUndefined();
  });

  it("falls back to the plan windows and marks a rejected 5h turn as reached", () => {
    expect(
      resolveComposerStatusLine({
        session: session({ modelProvider: "anthropic" }),
        now: 0,
        quotaGroups: [
          {
            providers: ["anthropic", "claude-cli"],
            displayName: "Claude",
            windows: [{ label: "5h", usedPercent: 93 }],
            budgets: [],
          },
        ],
      }).fiveHour,
    ).toEqual({ percent: 93, tone: "danger", reached: false });
    expect(
      resolveComposerStatusLine({
        now: 0,
        claudeUsage: {
          rows: [],
          rateLimit: { status: "rejected", limitType: "five_hour", observedAt: 0 },
        },
      }).fiveHour,
    ).toEqual({ percent: 100, tone: "danger", reached: true });
  });
});

describe("formatTurnElapsed", () => {
  it("formats seconds, minutes and hours compactly", () => {
    expect(formatTurnElapsed(8_400)).toBe("8s");
    expect(formatTurnElapsed(125_000)).toBe("2m 05s");
    expect(formatTurnElapsed(3_720_000)).toBe("1h 02m");
  });
});
