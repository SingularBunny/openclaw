// Fork (F62): managedTurns: false keeps ordinary claude-cli turns unmanaged; other restrictions still apply.
import { describe, expect, it } from "vitest";
import { resolveCliRuntimeToolPolicy } from "./prepare-tool-policy.js";
import type { RunCliAgentParams } from "./types.js";

const unmanaged = { plugins: { entries: { anthropic: { config: { managedTurns: false } } } } };
const params: RunCliAgentParams = {
  sessionId: "coding",
  sessionKey: "agent:coder:main",
  sessionFile: "fixture.jsonl",
  workspaceDir: "/workspace",
  prompt: "implement",
  provider: "claude-cli",
  model: "fixture",
  runId: "fixture-run",
  timeoutMs: 1000,
  config: unmanaged,
  sessionEntry: { sessionId: "coding", updatedAt: 1 },
};
const input = {
  params,
  policyAgentId: "coder",
  policySessionKey: params.sessionKey,
  backendId: "claude-cli",
  bundleMcp: true,
  canEnforceExactToolAvailability: true,
  isSideQuestion: false,
  skipsTurnPreparation: false,
};

describe("managed Claude CLI turns switch (fork)", () => {
  it("leaves an ordinary turn's native surface alone when managed turns are off", async () => {
    const result = await resolveCliRuntimeToolPolicy(input);
    expect(result.params.cliToolAvailability).toBeUndefined();
    expect(result.runtimeToolsAllowPolicy).toBeUndefined();
  });

  it("still manages ordinary turns by default and with managedTurns: true", async () => {
    for (const config of [
      {},
      { plugins: { entries: { anthropic: { config: { managedTurns: true } } } } },
    ]) {
      const result = await resolveCliRuntimeToolPolicy({ ...input, params: { ...params, config } });
      expect(result.params.cliToolAvailability).toEqual({ native: [], openClaw: [] });
    }
  });

  it("keeps delegated runs managed when managed turns are off", async () => {
    // The same delegation as upstream's prepare-tool-policy.delegation.test.ts.
    const sessionKey = "agent:coder:dashboard:coding";
    const result = await resolveCliRuntimeToolPolicy({
      ...input,
      policySessionKey: sessionKey,
      params: {
        ...params,
        sessionKey,
        config: {
          ...unmanaged,
          agents: {
            entries: {
              intake: { subagents: { allowAgents: ["coder"], delegateToolsTo: ["coder"] } },
              coder: {},
            },
          },
        },
        sessionEntry: {
          sessionId: "coding",
          updatedAt: 1,
          spawnedBy: "agent:intake:main",
          spawnDepth: 1,
          inheritedToolPolicyVersion: 1,
          inheritedToolDeny: ["exec"],
          delegatedToolPolicy: {
            requesterSessionKey: "agent:intake:main",
            targetAgentId: "coder",
            deny: [],
            requesterDeny: ["exec"],
          },
        },
      },
    });
    expect(result.params.cliToolAvailability).toEqual({ native: [], openClaw: [] });
  });
});
