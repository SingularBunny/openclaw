import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  createGatewayHarness,
  createTestSessionCapability,
} from "./session-capability.test-support.ts";

describe("session capability message cuts", () => {
  it("returns a committed rewind result after the connection is replaced", async () => {
    const committed = createDeferred<{
      editorText?: string;
      editorAttachments?: Array<{ mimeType: string; data: string }>;
    }>();
    const request = vi.fn((method: string) => {
      if (method === "sessions.rewind") {
        return committed.promise;
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const harness = createGatewayHarness(client);
    const sessions = createTestSessionCapability(harness.gateway);

    const pending = sessions.rewind("agent:main:main", "user-entry");
    harness.publish(false);
    committed.resolve({
      editorText: "edit me",
      editorAttachments: [{ mimeType: "image/png", data: "aW1hZ2U=" }],
    });

    await expect(pending).resolves.toEqual({
      editorText: "edit me",
      editorAttachments: [{ mimeType: "image/png", data: "aW1hZ2U=" }],
    });
    expect(request).toHaveBeenCalledWith("sessions.rewind", {
      sessionKey: "agent:main:main",
      entryId: "user-entry",
    });
    sessions.dispose();
  });

  it("asks the Gateway to restore Claude's file changes only when chosen (F52)", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.rewind") {
        return { editorText: "edit me", filesRestored: { count: 2 } };
      }
      return { sessions: [] };
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const { gateway } = createGatewayHarness(client);
    const sessions = createTestSessionCapability(gateway);

    await expect(
      sessions.rewind("agent:main:main", "user-entry", { restoreFiles: true }),
    ).resolves.toEqual({ editorText: "edit me", filesRestored: { count: 2 } });
    await sessions.rewind("agent:main:main", "user-entry", { restoreFiles: false });
    const rewinds = request.mock.calls.filter(([method]) => method === "sessions.rewind");
    expect(rewinds.map((call) => (call as unknown[])[1])).toEqual([
      { sessionKey: "agent:main:main", entryId: "user-entry", restoreFiles: true },
      { sessionKey: "agent:main:main", entryId: "user-entry" },
    ]);
    sessions.dispose();
  });

  it("returns a committed fork result when the replacement refresh fails", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.fork") {
        return {
          sessionKey: "agent:main:dashboard:forked",
          editorText: "edit me",
          editorAttachments: [{ mimeType: "image/png", data: "aW1hZ2U=" }],
        };
      }
      if (method === "sessions.list") {
        throw new Error("refresh failed");
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const { gateway } = createGatewayHarness(client);
    const sessions = createTestSessionCapability(gateway);

    await expect(sessions.forkAtMessage("agent:main:main", "user-entry")).resolves.toEqual({
      sessionKey: "agent:main:dashboard:forked",
      editorText: "edit me",
      editorAttachments: [{ mimeType: "image/png", data: "aW1hZ2U=" }],
    });
    expect(request).toHaveBeenCalledWith("sessions.fork", {
      sessionKey: "agent:main:main",
      entryId: "user-entry",
    });
    sessions.dispose();
  });

  it("lists branches and sends the selected leaf to the switch RPC", async () => {
    const branch = {
      leafEntryId: "branch-b",
      headline: "Try the earlier path",
      messageCount: 3,
      active: false,
    };
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.branches.list") {
        return { branches: [branch] };
      }
      if (method === "sessions.branches.switch") {
        return {};
      }
      if (method === "sessions.list") {
        return { sessions: [], count: 0 };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const { gateway } = createGatewayHarness(client);
    const sessions = createTestSessionCapability(gateway);

    await expect(sessions.listBranches("agent:main:main")).resolves.toEqual([branch]);
    await expect(sessions.switchBranch("agent:main:main", "branch-b")).resolves.toEqual({});
    expect(request).toHaveBeenCalledWith("sessions.branches.switch", {
      sessionKey: "agent:main:main",
      leafEntryId: "branch-b",
    });
    sessions.dispose();
  });

  it("sends the Claude transcript row of a merged message with the cut", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.rewind" || method === "sessions.fork") {
        return method === "sessions.fork" ? { sessionKey: "agent:main:dashboard:f" } : {};
      }
      if (method === "sessions.list") {
        return { sessions: [], count: 0 };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const { gateway } = createGatewayHarness(client);
    const sessions = createTestSessionCapability(gateway);

    await sessions.rewind("agent:main:main", "next-local", {
      nativeMessageId: "claude-uuid",
      nativeOnly: true,
    });
    await sessions.forkAtMessage("agent:main:main", "local", { nativeMessageId: "claude-twin" });
    expect(request).toHaveBeenCalledWith("sessions.rewind", {
      sessionKey: "agent:main:main",
      entryId: "next-local",
      nativeMessageId: "claude-uuid",
      nativeOnly: true,
    });
    expect(request).toHaveBeenCalledWith("sessions.fork", {
      sessionKey: "agent:main:main",
      entryId: "local",
      nativeMessageId: "claude-twin",
    });
    sessions.dispose();
  });
});
