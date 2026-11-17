import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import { readCronRunNextCheckFollowUpDepth } from "../../cron/follow-up-chain-run.js";
import { consumeCronNextCheckProposal } from "../../infra/agent-run-registry.automation.js";
import {
  claimAgentRunContext,
  clearAgentRunContext,
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
        [
          JOB_ID,
          { nextCheckEnabled: true, assertCurrent: () => {}, ...(followUp ? { followUp } : {}) },
        ],
      ]),
    },
    { trackOwner: true, ownsContext: true },
  );
}

function scopedTool(callGatewayTool = vi.fn()) {
  return createCronTool({ selfRemoveOnlyJobId: JOB_ID, runId: RUN_ID }, { callGatewayTool });
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
