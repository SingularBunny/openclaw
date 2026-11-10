import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  patchSessionEntryCore: vi.fn(),
  emitSessionLifecycleEvent: vi.fn(),
}));
vi.mock("../../config/sessions/session-accessor.js", () => ({
  patchSessionEntryCore: mocks.patchSessionEntryCore,
}));
vi.mock("../../sessions/session-lifecycle-events.js", () => ({
  emitSessionLifecycleEvent: mocks.emitSessionLifecycleEvent,
}));

const { createClaudePermissionModeRecorder, resolveRunClaudePermissionMode } =
  await import("./claude-permission-mode.js");

const run = {
  agentId: "main",
  sessionId: "session-1",
  sessionKey: "agent:main:thread",
  storePath: "/state/sessions.sqlite",
};

describe("Claude permission mode of a CLI run", () => {
  beforeEach(() => {
    mocks.patchSessionEntryCore.mockReset();
    mocks.emitSessionLifecycleEvent.mockReset();
  });

  it("passes only an explicit session choice", () => {
    expect(resolveRunClaudePermissionMode({ ...run })).toBeUndefined();
    expect(resolveRunClaudePermissionMode({ ...run, sessionEntry: {} })).toBeUndefined();
    expect(
      resolveRunClaudePermissionMode({ ...run, sessionEntry: { claudePermissionMode: "plan" } }),
    ).toBe("plan");
  });

  it("stores the approved mode on the same session and announces the row change", async () => {
    mocks.patchSessionEntryCore.mockImplementation(async (_scope, update) => {
      expect(update({ sessionId: "session-1" })).toEqual({ claudePermissionMode: "acceptEdits" });
      expect(update({ sessionId: "after-reset" })).toBeNull();
      return { sessionId: "session-1", claudePermissionMode: "acceptEdits" };
    });
    await createClaudePermissionModeRecorder(run)?.("acceptEdits");

    expect(mocks.patchSessionEntryCore).toHaveBeenCalledWith(
      { agentId: "main", sessionKey: "agent:main:thread", storePath: "/state/sessions.sqlite" },
      expect.any(Function),
      { preserveActivity: true, skipMaintenance: true },
    );
    expect(mocks.emitSessionLifecycleEvent).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: "agent:main:thread", scope: "session-entry" }),
    );
  });

  it("ignores unknown modes, missing session keys, and store failures", async () => {
    await createClaudePermissionModeRecorder(run)?.("manual");
    expect(createClaudePermissionModeRecorder({ sessionId: "s" })).toBeUndefined();
    mocks.patchSessionEntryCore.mockRejectedValue(new Error("locked"));
    await expect(createClaudePermissionModeRecorder(run)?.("default")).resolves.toBeUndefined();
    expect(mocks.emitSessionLifecycleEvent).not.toHaveBeenCalled();
  });
});
