import type { CliBackendExecuteContext } from "openclaw/plugin-sdk/cli-backend";
import { describe, expect, it, vi } from "vitest";
import {
  createClaudeCliPlanApprover,
  createSetPermissionModeRequest,
  readClaudeCliPermissionMode,
  resolveClaudeCliModeGate,
} from "./cli-permission-mode.js";

describe("resolveClaudeCliModeGate", () => {
  it.each([
    [undefined, "Edit", "host"],
    [undefined, "Bash", "host"],
    ["default", "Edit", "ask"],
    ["default", "Bash", "ask"],
    ["default", "Read", "host"],
    ["acceptEdits", "Write", "host"],
    ["acceptEdits", "PowerShell", "ask"],
    ["plan", "MultiEdit", "deny"],
    ["plan", "Bash", "ask"],
    ["plan", "Grep", "host"],
    ["bypassPermissions", "Edit", "host"],
    ["dontAsk", "Bash", "host"],
    ["auto", "NotebookEdit", "host"],
  ] as const)("%s + %s -> %s", (mode, tool, kind) => {
    expect(resolveClaudeCliModeGate(mode, tool).kind).toBe(kind);
  });
});

describe("Claude CLI permission mode values", () => {
  it("accepts only exact CLI values", () => {
    expect(readClaudeCliPermissionMode("acceptEdits")).toBe("acceptEdits");
    expect(readClaudeCliPermissionMode("manual")).toBeUndefined();
    expect(readClaudeCliPermissionMode(undefined)).toBeUndefined();
  });

  it("builds the stream-json mode switch", () => {
    expect(createSetPermissionModeRequest("acceptEdits", "x")).toEqual({
      type: "control_request",
      request_id: "set_permission_mode_x",
      request: { subtype: "set_permission_mode", mode: "acceptEdits" },
    });
  });
});

describe("createClaudeCliPlanApprover", () => {
  function contextWith(requestUserInput: CliBackendExecuteContext["requestUserInput"]) {
    return { requestUserInput } as unknown as CliBackendExecuteContext;
  }

  it("keeps plan mode when the card is dismissed", async () => {
    const requestUserInput = vi.fn<CliBackendExecuteContext["requestUserInput"]>(async () => ({
      status: "cancelled",
      message: "Form input expired.",
    }));
    const approver = createClaudeCliPlanApprover(contextWith(requestUserInput));
    const decision = await approver.approve({
      input: { plan: "do it" },
      signal: new AbortController().signal,
      toolUseId: "tool-1",
    });

    expect(decision.mode).toBeUndefined();
    expect(decision.result).toMatchObject({
      behavior: "deny",
      message: expect.stringContaining("stay in plan mode"),
    });
  });

  it("asks once per tool call", async () => {
    const requestUserInput = vi.fn<CliBackendExecuteContext["requestUserInput"]>(async () => ({
      status: "answered",
      answers: { plan_approval: ["Yes, and auto-accept edits"] },
    }));
    const approver = createClaudeCliPlanApprover(contextWith(requestUserInput));
    const signal = new AbortController().signal;
    const [first, second] = await Promise.all([
      approver.approve({ input: { plan: "p" }, signal, toolUseId: "tool-1" }),
      approver.approve({ input: { plan: "p" }, signal, toolUseId: "tool-1" }),
    ]);

    expect(first).toBe(second);
    expect(first.mode).toBe("acceptEdits");
    expect(requestUserInput).toHaveBeenCalledOnce();
  });
});
