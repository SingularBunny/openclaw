import { describe, expect, it } from "vitest";
import type { CronJob } from "../cron/types.js";
import { sessionAutomationParentKey } from "./session-automation-parent-fork.js";

const job = (patch: Partial<CronJob>) => ({ id: "j1", enabled: true, ...patch }) as CronJob;

describe("sessionAutomationParentKey", () => {
  const parent = "agent:ops:cron:ce18c1ed-0096-4297-b66c-9693cbc7925d";
  const jobs = [
    job({
      id: "528c3083",
      sessionTarget: "current",
      sessionKey: parent,
      owner: { agentId: "ops" } as never,
    }),
    job({
      id: "ce18c1ed-0096-4297-b66c-9693cbc7925d",
      sessionTarget: "isolated",
      owner: { agentId: "ops" } as never,
    }),
    job({ id: "abc", sessionTarget: "current", sessionKey: "agent:main:main" }),
  ];

  it("names the chat a job set up from it reports to", () => {
    expect(
      sessionAutomationParentKey("agent:ops:cron:528c3083", { jobs, defaultAgentId: "main" }),
    ).toBe(parent);
    expect(
      sessionAutomationParentKey("agent:main:cron:abc", { jobs, defaultAgentId: "main" }),
    ).toBe("agent:main:main");
  });

  it("leaves automations the owner set up, other sessions and an unloaded cron store alone", () => {
    expect(sessionAutomationParentKey(parent, { jobs, defaultAgentId: "main" })).toBeUndefined();
    expect(
      sessionAutomationParentKey("agent:main:main", { jobs, defaultAgentId: "main" }),
    ).toBeUndefined();
    expect(
      sessionAutomationParentKey("agent:ops:cron:528c3083", {
        jobs: undefined,
        defaultAgentId: "main",
      }),
    ).toBeUndefined();
  });
});
