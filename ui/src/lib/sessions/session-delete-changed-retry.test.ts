// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { GatewayRequestError } from "../../api/gateway.ts";
import { createSessionDeletionHarness } from "./session-deletion.test-support.ts";

const sessionChanged = (key: string) =>
  new GatewayRequestError({
    code: "INVALID_REQUEST",
    message: `Session ${key} changed before deletion. Retry.`,
    details: { reason: "session-changed" },
  });

const deleteCalls = (h: ReturnType<typeof createSessionDeletionHarness>) =>
  h.request.mock.calls.filter(([method]) => method === "sessions.delete");

describe("session delete after a concurrent row change", () => {
  it("retries once and confirms when the session settled", async () => {
    const h = createSessionDeletionHarness();
    try {
      await h.sessions.refresh({ force: true });
      const operation = h.sessions.delete(h.alpha.key, { expectedSessionId: h.alpha.sessionId });
      await vi.waitFor(() => expect(h.responses.has(h.alpha.key)).toBe(true));
      const first = h.responses.get(h.alpha.key)!;
      first.reject(sessionChanged(h.alpha.key));
      await vi.waitFor(() => expect(deleteCalls(h)).toHaveLength(2));
      expect(deleteCalls(h)[1]?.[1]).toMatchObject({
        key: h.alpha.key,
        expectedSessionId: h.alpha.sessionId,
      });
      h.responses.get(h.alpha.key)!.resolve({ deleted: true });
      await expect(operation).resolves.toMatchObject({ deleted: true });
      expect(h.sessions.deletionState(h.alpha.key)).toBe("confirmed");
    } finally {
      h.sessions.dispose();
    }
  });

  it("restores the row and reports the error when the retry is rejected too", async () => {
    const h = createSessionDeletionHarness();
    try {
      await h.sessions.refresh({ force: true });
      const operation = h.sessions.delete(h.alpha.key, { expectedSessionId: h.alpha.sessionId });
      await vi.waitFor(() => expect(h.responses.has(h.alpha.key)).toBe(true));
      h.responses.get(h.alpha.key)!.reject(sessionChanged(h.alpha.key));
      await vi.waitFor(() => expect(deleteCalls(h)).toHaveLength(2));
      h.responses.get(h.alpha.key)!.reject(sessionChanged(h.alpha.key));
      await expect(operation).rejects.toThrow("changed before deletion");
      expect(deleteCalls(h)).toHaveLength(2);
      expect(h.sessions.deletionState(h.alpha.key)).toBeUndefined();
      expect(h.sessions.state.error).toContain("changed before deletion");
    } finally {
      h.sessions.dispose();
    }
  });

  it("does not retry other rejections", async () => {
    const h = createSessionDeletionHarness();
    try {
      await h.sessions.refresh({ force: true });
      const operation = h.sessions.delete(h.alpha.key);
      await vi.waitFor(() => expect(h.responses.has(h.alpha.key)).toBe(true));
      h.responses.get(h.alpha.key)!.reject(new Error("delete rejected"));
      await expect(operation).rejects.toThrow("delete rejected");
      expect(deleteCalls(h)).toHaveLength(1);
      expect(h.sessions.deletionState(h.alpha.key)).toBeUndefined();
    } finally {
      h.sessions.dispose();
    }
  });
});
