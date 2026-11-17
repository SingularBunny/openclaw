import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import { readCronRunNextCheckFollowUpDepth } from "../../cron/follow-up-chain-run.js";
import { CRON_FOLLOW_UP_ONLY_MESSAGE } from "../../cron/follow-up-chain.js";
import {
  claimAgentRunContext,
  clearAgentRunContext,
  consumeCronNextCheckProposal,
  releaseAgentRunContext,
} from "../../infra/agent-run-registry.js";
import { createCronTool } from "./cron-tool.js";

const RUN_ID = "follow-up-run";
const JOB_ID = "follow-up-job";
let runClaimId: string | undefined;

function registerRun(followUp?: { depth: number; ownerOrigin: boolean }) {
  runClaimId = claimAgentRunContext(
    RUN_ID,
    {
      sessionKey: "agent:main:cron:origin-job",
      cronRunsByJobId: new Map([
        [JOB_ID, { nextCheckEnabled: true, ...(followUp ? { followUp } : {}) }],
      ]),
    },
    { trackOwner: true, ownsContext: true },
  );
}

function scopedTool(followUpOnly?: true, callGatewayTool = vi.fn()) {
  return createCronTool(
    { selfRemoveOnlyJobId: JOB_ID, runId: RUN_ID, ...(followUpOnly ? { followUpOnly } : {}) },
    { callGatewayTool },
  );
}

function nextCheck(tool = scopedTool()) {
  return tool.execute("call-next-check", { action: "next_check", in: "20m" });
}

beforeEach(() => {
  setRuntimeConfigSnapshot({});
});

afterEach(() => {
  releaseAgentRunContext(RUN_ID, runClaimId);
  clearAgentRunContext(RUN_ID);
  runClaimId = undefined;
  clearRuntimeConfigSnapshot();
});

describe("automations next_check with cron.followUpChainLimit", () => {
  it("keeps upstream next_check at limit 0: no cap and no depth", async () => {
    registerRun({ depth: 7, ownerOrigin: false });
    await nextCheck();
    expect(readCronRunNextCheckFollowUpDepth(RUN_ID, JOB_ID)).toBeUndefined();
    expect(consumeCronNextCheckProposal(RUN_ID, JOB_ID)).toBe(20 * 60_000);
  });

  it("carries the next depth when the chain is under the limit", async () => {
    setRuntimeConfigSnapshot({ cron: { followUpChainLimit: 2 } });
    registerRun({ depth: 1, ownerOrigin: true });
    await nextCheck();
    expect(readCronRunNextCheckFollowUpDepth(RUN_ID, JOB_ID)).toBe(2);
    expect(consumeCronNextCheckProposal(RUN_ID, JOB_ID)).toBe(20 * 60_000);
  });

  it("refuses at the limit without recording a proposal", async () => {
    setRuntimeConfigSnapshot({ cron: { followUpChainLimit: 2 } });
    registerRun({ depth: 2, ownerOrigin: true });
    await expect(nextCheck()).rejects.toThrow(
      "Follow-up limit 2 reached for this automation chain; ask the owner.",
    );
    expect(consumeCronNextCheckProposal(RUN_ID, JOB_ID)).toBeUndefined();
  });

  it("refuses a chain that no owner-created job started", async () => {
    setRuntimeConfigSnapshot({ cron: { followUpChainLimit: 2 } });
    registerRun({ depth: 0, ownerOrigin: false });
    await expect(nextCheck()).rejects.toThrow("not started by a job the owner created");
  });

  it("leaves paced jobs (no chain link) uncapped", async () => {
    setRuntimeConfigSnapshot({ cron: { followUpChainLimit: 1 } });
    registerRun();
    await nextCheck();
    expect(readCronRunNextCheckFollowUpDepth(RUN_ID, JOB_ID)).toBeUndefined();
  });
});

describe("follow-up-only automations scope", () => {
  it.each([
    [
      "add a recurring job",
      { action: "add", job: { schedule: { kind: "every", everyMs: 60_000 } } },
    ],
    [
      "target another session",
      {
        action: "add",
        job: {
          schedule: { kind: "at", at: "2026-11-17T18:00:00.000Z" },
          sessionTarget: "session:agent:main:other",
          payload: { kind: "agentTurn", message: "elsewhere" },
        },
      },
    ],
    ["delete a job", { action: "remove", jobId: "other-job" }],
    ["delete its own job", { action: "remove", jobId: JOB_ID }],
    ["edit a job", { action: "update", jobId: JOB_ID, job: { enabled: false } }],
    ["run a job", { action: "run", jobId: "other-job" }],
    ["list jobs", { action: "list" }],
    ["wake a session", { action: "wake", text: "hi", sessionKey: "agent:main:other" }],
  ])("refuses to %s", async (_label, args) => {
    setRuntimeConfigSnapshot({ cron: { followUpChainLimit: 2 } });
    registerRun({ depth: 0, ownerOrigin: true });
    const callGatewayTool = vi.fn();
    await expect(scopedTool(true, callGatewayTool).execute("call", args)).rejects.toThrow(
      CRON_FOLLOW_UP_ONLY_MESSAGE,
    );
    expect(callGatewayTool).not.toHaveBeenCalled();
  });

  it("accepts next_check", async () => {
    setRuntimeConfigSnapshot({ cron: { followUpChainLimit: 2 } });
    registerRun({ depth: 0, ownerOrigin: true });
    await nextCheck(scopedTool(true));
    expect(readCronRunNextCheckFollowUpDepth(RUN_ID, JOB_ID)).toBe(1);
  });
});
