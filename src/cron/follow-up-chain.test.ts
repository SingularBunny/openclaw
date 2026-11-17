import { describe, expect, it } from "vitest";
import {
  CRON_FOLLOW_UP_NOT_OWNER_ORIGIN,
  decideCronFollowUp,
  describeCronFollowUpChainLink,
  resolveCronFollowUpChainLimit,
} from "./follow-up-chain.js";
import type { CronStoredJob } from "./types.js";

type LinkJob = Parameters<typeof describeCronFollowUpChainLink>[0];

function continuation(overrides: Partial<CronStoredJob> = {}): LinkJob {
  return {
    schedule: { kind: "at", at: "2026-11-17T17:00:00.000Z" },
    sessionTarget: "session:agent:main:cron:origin-job",
    payload: { kind: "agentTurn", message: "Restart the next job in the queue." },
    state: {},
    createdActor: { type: "system" },
    toolsAllowProvenance: {
      version: 1,
      source: "final-executable-surface",
      callerOrigin: { kind: "local" },
    },
    ...overrides,
  } as LinkJob;
}

describe("cron.followUpChainLimit", () => {
  it("reads only positive integers and caps the range", () => {
    expect(resolveCronFollowUpChainLimit(undefined)).toBe(0);
    expect(resolveCronFollowUpChainLimit({ cron: {} })).toBe(0);
    expect(resolveCronFollowUpChainLimit({ cron: { followUpChainLimit: 0 } })).toBe(0);
    expect(resolveCronFollowUpChainLimit({ cron: { followUpChainLimit: 2 } })).toBe(2);
    expect(resolveCronFollowUpChainLimit({ cron: { followUpChainLimit: 1.5 } })).toBe(0);
    expect(resolveCronFollowUpChainLimit({ cron: { followUpChainLimit: 500 } })).toBe(50);
  });

  it("leaves every decision unchanged at 0", () => {
    for (const link of [
      undefined,
      { depth: 0, ownerOrigin: true },
      { depth: 9, ownerOrigin: false },
    ]) {
      expect(decideCronFollowUp({ limit: 0, link })).toEqual({ kind: "unchanged" });
    }
  });

  it("allows N chained follow-ups from an owner-created job, then refuses", () => {
    let depth = describeCronFollowUpChainLink(continuation())!.depth;
    expect(depth).toBe(0);
    const decisions = [];
    for (let step = 0; step < 3; step += 1) {
      const decision = decideCronFollowUp({ limit: 2, link: { depth, ownerOrigin: true } });
      decisions.push(decision);
      if (decision.kind === "allowed") {
        depth = describeCronFollowUpChainLink(
          continuation({ state: { followUpDepth: decision.nextDepth } }),
        )!.depth;
      }
    }
    expect(decisions).toEqual([
      { kind: "allowed", nextDepth: 1 },
      { kind: "allowed", nextDepth: 2 },
      {
        kind: "denied",
        message:
          "Follow-up limit 2 reached for this automation chain; ask the owner. Do not retry next_check.",
      },
    ]);
  });

  it("recognizes owner-created origins only", () => {
    expect(describeCronFollowUpChainLink(continuation())?.ownerOrigin).toBe(true);
    expect(
      describeCronFollowUpChainLink(
        continuation({
          toolsAllowProvenance: {
            version: 1,
            source: "final-executable-surface",
            callerOrigin: { kind: "external", channel: "telegram" },
          },
        }),
      )?.ownerOrigin,
    ).toBe(true);
    const nonOwner = [
      continuation({ toolsAllowProvenance: undefined }),
      continuation({ createdActor: { type: "agent" } }),
      continuation({
        toolsAllowProvenance: {
          version: 1,
          source: "final-executable-surface",
          callerOrigin: { kind: "unknown" },
        },
      }),
      continuation({
        toolsAllowProvenance: {
          version: 1,
          source: "authenticated-requester",
          channelRequester: { version: 1, channel: "telegram", accountId: "a", senderId: "guest" },
        },
      }),
    ];
    for (const job of nonOwner) {
      const link = describeCronFollowUpChainLink(job);
      expect(link?.ownerOrigin).toBe(false);
      expect(decideCronFollowUp({ limit: 2, link })).toEqual({
        kind: "denied",
        message: CRON_FOLLOW_UP_NOT_OWNER_ORIGIN,
      });
    }
  });

  it("keeps recurring and non-continuation jobs outside any chain", () => {
    for (const job of [
      continuation({ schedule: { kind: "every", everyMs: 60_000 } }),
      continuation({ sessionTarget: "isolated" }),
      continuation({ payload: { kind: "systemEvent", text: "ping" } }),
    ]) {
      expect(describeCronFollowUpChainLink(job)).toBeUndefined();
      expect(decideCronFollowUp({ limit: 2, link: undefined })).toEqual({ kind: "unchanged" });
    }
  });
});
