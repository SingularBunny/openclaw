// @vitest-environment node
import { describe, expect, it } from "vitest";
import { deriveSessionUnread } from "../../../../src/shared/session-unread.ts";
import { SessionUnreadPatchGuard } from "./unread.ts";

// A silent automation turn stores markedUnreadAt; the open pane must not swallow it.
describe("automation unread marker", () => {
  it("survives the presented pane and clears when the chat is opened again", () => {
    const guard = new SessionUnreadPatchGuard();
    guard.beginActivation("agent:main:cron:a");
    // The pane was read before the run.
    expect(guard.shouldPatch("agent:main:cron:a", false)).toBe(false);
    // Activity alone (user-started or visible turn) is still acknowledged at once.
    expect(guard.shouldPatch("agent:main:cron:a", true)).toBe(true);
    guard.settlePatch()(true);
    expect(guard.shouldPatch("agent:main:cron:a", false)).toBe(false);
    // The automation marker lands while the same pane stays presented.
    expect(guard.shouldPatch("agent:main:cron:a", true, 500)).toBe(false);
    expect(guard.shouldPatch("agent:main:cron:a", true, 500)).toBe(false);
    // Opening the chat starts a new activation and acknowledges the marker.
    guard.beginActivation("agent:main:cron:a");
    expect(guard.shouldPatch("agent:main:cron:a", true, 500)).toBe(true);
  });

  it("keeps the row unread after an implicit read until the marker is cleared", () => {
    const row = { createdAt: 1, lastActivityAt: 10, lastReadAt: 11 };
    expect(deriveSessionUnread(row)).toBe(false);
    expect(deriveSessionUnread({ ...row, markedUnreadAt: 10 })).toBe(true);
  });
});
