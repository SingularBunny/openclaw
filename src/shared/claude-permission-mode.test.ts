import { describe, expect, it } from "vitest";
import { normalizeClaudePermissionMode } from "./claude-permission-mode.js";
import { resolveDynamicSessionMutationRequiredScope } from "./session-method-scopes.js";

describe("Claude CLI permission mode scopes", () => {
  it.each(["default", "acceptEdits", "plan", "dontAsk", "auto", null])(
    "keeps %s at write scope",
    (claudePermissionMode) => {
      expect(
        resolveDynamicSessionMutationRequiredScope("sessions.patch", {
          key: "agent:main:thread",
          expectedSessionId: "session-1",
          claudePermissionMode,
        }),
      ).toBe("operator.write");
    },
  );

  it("requires admin for bypassPermissions, like permissionMode full", () => {
    expect(
      resolveDynamicSessionMutationRequiredScope("sessions.patch", {
        key: "agent:main:thread",
        claudePermissionMode: "bypassPermissions",
      }),
    ).toBe("operator.admin");
    expect(
      resolveDynamicSessionMutationRequiredScope("sessions.patchMany", {
        targets: [{ key: "agent:main:thread" }],
        patch: { claudePermissionMode: "bypassPermissions" },
      }),
    ).toBe("operator.admin");
  });

  it("normalizes exact CLI values only", () => {
    expect(normalizeClaudePermissionMode(" plan ")).toBe("plan");
    expect(normalizeClaudePermissionMode("bypass")).toBeUndefined();
    expect(normalizeClaudePermissionMode(1)).toBeUndefined();
  });
});
