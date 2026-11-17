import { afterEach, describe, expect, it } from "vitest";
import { resolveTurnToolSurface } from "../agents/agent-tools.turn-authority.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import {
  claimAgentRunContext,
  clearAgentRunContext,
  releaseAgentRunContext,
} from "../infra/agent-run-registry.js";
import { resolveGatewayOwnerOnlyToolDenylist } from "../security/dangerous-tools.js";
import {
  liftFollowUpAutomationsDeny,
  resolveGatewayCronFollowUpGrant,
} from "./tool-resolution-follow-up.js";

const RUN_ID = "cli-follow-up-run";
const JOB_ID = "cli-follow-up-job";
let claim: string | undefined;

function registerRun(followUp?: { depth: number; ownerOrigin: boolean }) {
  claim = claimAgentRunContext(
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

function grant(params: { limit?: number; surface?: "http" | "loopback"; senderIsOwner?: boolean }) {
  return resolveGatewayCronFollowUpGrant({
    cfg: params.limit === undefined ? {} : { cron: { followUpChainLimit: params.limit } },
    surface: params.surface ?? "loopback",
    senderIsOwner: params.senderIsOwner ?? false,
    runId: RUN_ID,
  });
}

function fakeTool(name: string): AnyAgentTool {
  return {
    name,
    label: name,
    description: name,
    parameters: {},
    execute: async () => ({}),
  } as never;
}

afterEach(() => {
  releaseAgentRunContext(RUN_ID, claim);
  clearAgentRunContext(RUN_ID);
  claim = undefined;
});

describe("Gateway follow-up grant (cron.followUpChainLimit)", () => {
  it("keeps the owner-only refusal unchanged at limit 0", async () => {
    registerRun({ depth: 0, ownerOrigin: true });
    for (const limit of [undefined, 0]) {
      expect(grant({ limit })).toBeUndefined();
    }
    const deny = liftFollowUpAutomationsDeny(resolveGatewayOwnerOnlyToolDenylist(false), undefined);
    expect(deny).toEqual(resolveGatewayOwnerOnlyToolDenylist(false));
    const surface = resolveTurnToolSurface({
      turnTools: [fakeTool("automations")],
      ownerOnlyDenied: new Set(deny),
    });
    await expect(surface.tools[0]!.execute("call", {}, undefined as never)).resolves.toEqual({
      content: [
        {
          type: "text",
          text: "automations needs the owner's authority, and this turn was not started by the owner. Do not retry automations.",
        },
      ],
      details: { gated: true },
    });
  });

  it("scopes automations to the owner-created continuation when the limit is set", () => {
    registerRun({ depth: 1, ownerOrigin: true });
    const followUp = grant({ limit: 2 });
    expect(followUp).toEqual({ cronSelfRemoveOnlyJobId: JOB_ID, cronFollowUpOnly: true });
    const before = resolveGatewayOwnerOnlyToolDenylist(false);
    const after = liftFollowUpAutomationsDeny(before, followUp);
    expect(before).toContain("automations");
    expect(after).toEqual(before.filter((name) => name !== "automations"));
    const surface = resolveTurnToolSurface({
      turnTools: [fakeTool("automations"), fakeTool("sessions")],
      ownerOnlyDenied: new Set(after),
    });
    expect(surface.callableTools.map((tool) => tool.name)).toEqual(["automations"]);
  });

  it("grants nothing outside an owner-origin scheduled continuation", () => {
    registerRun({ depth: 0, ownerOrigin: false });
    expect(grant({ limit: 2 })).toBeUndefined();
    releaseAgentRunContext(RUN_ID, claim);
    clearAgentRunContext(RUN_ID);
    registerRun();
    expect(grant({ limit: 2 })).toBeUndefined();
    releaseAgentRunContext(RUN_ID, claim);
    clearAgentRunContext(RUN_ID);
    claim = undefined;
    expect(grant({ limit: 2 })).toBeUndefined();
  });

  it("leaves owner turns and the HTTP surface alone", () => {
    registerRun({ depth: 0, ownerOrigin: true });
    expect(grant({ limit: 2, senderIsOwner: true })).toBeUndefined();
    expect(grant({ limit: 2, surface: "http" })).toBeUndefined();
  });
});
