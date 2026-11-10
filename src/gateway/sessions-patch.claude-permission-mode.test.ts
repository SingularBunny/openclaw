// Fork (F49): the Claude CLI permission mode is an ordinary stored session setting.
import { describe, expect, test } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import { expectPatchError, expectPatchOk, runPatch } from "./sessions-patch.test-support.js";

const key = "agent:main:dashboard:claude";

describe("claudePermissionMode", () => {
  test("stores a mode, replaces it, and clears it with null", async () => {
    const store: Record<string, SessionEntry> = { [key]: { sessionId: "claude", updatedAt: 1 } };
    const patch = (claudePermissionMode: "plan" | "acceptEdits" | null) =>
      runPatch({ store, storeKey: key, patch: { key, claudePermissionMode } });

    expect(expectPatchOk(await patch("plan")).claudePermissionMode).toBe("plan");
    expect(expectPatchOk(await patch("acceptEdits")).claudePermissionMode).toBe("acceptEdits");
    expect(expectPatchOk(await patch(null))).not.toHaveProperty("claudePermissionMode");
  });

  test("leaves sessions without a choice unchanged", async () => {
    const store: Record<string, SessionEntry> = { [key]: { sessionId: "claude", updatedAt: 1 } };
    const entry = expectPatchOk(
      await runPatch({ store, storeKey: key, patch: { key, pinned: true } }),
    );
    expect(entry).not.toHaveProperty("claudePermissionMode");
  });

  test("rejects values the CLI does not accept", async () => {
    expectPatchError(
      await runPatch({
        store: { [key]: { sessionId: "claude", updatedAt: 1 } },
        storeKey: key,
        patch: { key, claudePermissionMode: "manual" as never },
      }),
      "invalid claudePermissionMode",
    );
  });
});
