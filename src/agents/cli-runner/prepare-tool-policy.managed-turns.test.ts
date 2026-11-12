// Fork (F62, C10): managedTurns: false keeps ordinary claude-cli turns unmanaged; managed turns keep local-state tools.
import { describe, expect, it } from "vitest";
import {
  keptManagedNativeTools,
  resolveCliBootstrapFileAccess,
  resolveCliRuntimeToolPolicy,
} from "./prepare-tool-policy.js";
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

describe("local-state tools on managed turns (fork)", () => {
  const todo = ["TodoWrite", "TaskCreate"];
  const managed = { ...input, params: { ...params, config: {} }, managedLocalStateTools: todo };

  it("keeps local-state tools next to the operator's selection on ordinary managed turns", async () => {
    const result = await resolveCliRuntimeToolPolicy({
      ...managed,
      resolveManagedNativeTools: () => ["Agent"],
    });
    expect(result.params.cliToolAvailability).toEqual({
      native: ["Agent", ...todo],
      openClaw: [],
    });
    expect(keptManagedNativeTools(result.managedNativeTools, result.params, todo)).toEqual([
      "Agent",
    ]);
  });

  it("gives local-state tools no file access", async () => {
    const result = await resolveCliRuntimeToolPolicy(managed);
    expect(result.params.cliToolAvailability?.native).toEqual(todo);
    expect(
      resolveCliBootstrapFileAccess({
        backend: { id: "claude-cli", nativeToolMode: "selectable" },
        params: result.params,
        managedNativeTools: result.managedNativeTools,
        projectedToolNames: [],
      }),
    ).toBe(false);
  });

  it("leaves restricted runs without local-state tools", async () => {
    const result = await resolveCliRuntimeToolPolicy({
      ...managed,
      params: { ...params, config: {}, toolsAllow: ["read"] },
    });
    expect(result.params.cliToolAvailability?.native).toEqual([]);
  });
});
