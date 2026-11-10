import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import { buildChatClaudeModePicker } from "./chat-claude-mode-controls.ts";
import { patchChatSessionSettings } from "./chat-settings-patches.ts";
import type { ChatPageHost } from "./chat-state-host.ts";

vi.mock("./chat-settings-patches.ts", () => ({ patchChatSessionSettings: vi.fn() }));
const patch = vi.mocked(patchChatSessionSettings);

const claudeRow = {
  key: "agent:main:claude",
  kind: "direct",
  updatedAt: 1,
  sessionId: "claude-session",
  modelProvider: "claude-cli",
  claudePermissionMode: "plan",
} as GatewaySessionRow;

function build(selectedSession: GatewaySessionRow | undefined, allowed = true) {
  const state = {
    requestUpdate: vi.fn(),
    chatError: null,
    lastError: null,
  } as unknown as ChatPageHost;
  const canPatch = vi.fn(() => true);
  const picker = buildChatClaudeModePicker({
    state,
    selectedSession,
    sessionKey: "agent:main:claude",
    agentId: "main",
    expectedSessionId: "claude-session",
    access: allowed
      ? { allowed: true, requiredScope: "operator.write" }
      : ({ allowed: false, reason: "Requires operator.write" } as never),
    canSelectBypass: false,
    canPatch,
    ownsSelection: () => true,
  });
  return { state, picker, canPatch };
}

describe("buildChatClaudeModePicker", () => {
  beforeEach(() => patch.mockReset());

  it("is offered only for claude-cli sessions", () => {
    expect(build({ ...claudeRow, modelProvider: "openai" }).picker).toBeUndefined();
    expect(build(undefined).picker).toBeUndefined();
    expect(build(claudeRow).picker).toMatchObject({ mode: "plan", canSelectBypass: false });
  });

  it("patches the session with sessions.patch and the observed session id", async () => {
    patch.mockResolvedValue({ ok: true, key: claudeRow.key } as never);
    const { picker, state } = build(claudeRow);
    await picker!.onSelect("acceptEdits");
    expect(patch).toHaveBeenCalledWith(
      state,
      "agent:main:claude",
      { claudePermissionMode: "acceptEdits" },
      expect.objectContaining({ agentId: "main", expectedSessionId: "claude-session" }),
    );
    await picker!.onSelect(null);
    expect(patch.mock.calls[1]?.[2]).toEqual({ claudePermissionMode: null });
  });

  it("reports a failed write and does nothing without write access", async () => {
    patch.mockRejectedValueOnce(new Error("denied"));
    const { picker, state } = build(claudeRow);
    await picker!.onSelect("default");
    expect(state.chatError).toContain("Could not change the Claude Code mode");

    const readOnly = build(claudeRow, false);
    expect(readOnly.picker?.disabled).toBe(true);
    await readOnly.picker!.onSelect("default");
    expect(patch).toHaveBeenCalledOnce();
  });
});
