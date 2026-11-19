import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  agentDisplayName,
  resolveAgentTargetId,
  withAgentListOnUnknownAgent,
} from "./agent-target-by-name-fork.js";

const cfg = {
  agents: {
    entries: {
      main: { identity: { name: "Claude" } },
      ops: { identity: { name: "Ops Desk" } },
      notes: {},
    },
  },
} as unknown as OpenClawConfig;

describe("agent targets by display name", () => {
  it("keeps ids and maps a display name to its id without case", () => {
    expect(resolveAgentTargetId(cfg, "ops")).toBe("ops");
    expect(resolveAgentTargetId(cfg, "claude")).toBe("main");
    expect(resolveAgentTargetId(cfg, "OPS DESK")).toBe("ops");
    expect(agentDisplayName(cfg, "main")).toBe("Claude");
    expect(agentDisplayName(cfg, "notes")).toBeUndefined();
  });

  it("passes an unknown target on and lists the agents when the Gateway refuses it", () => {
    expect(resolveAgentTargetId(cfg, "reviewer")).toBe("reviewer");
    const error = withAgentListOnUnknownAgent(cfg, new Error('Unknown agent id "reviewer"'));
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("main (Claude)");
    expect((error as Error).message).toContain("ops (Ops Desk)");
    const other = new Error("timeout");
    expect(withAgentListOnUnknownAgent(cfg, other)).toBe(other);
  });
});
