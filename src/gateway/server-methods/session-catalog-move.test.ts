import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import type { SessionCatalogProvider } from "../../plugins/session-catalog.js";
import { catalogResult } from "./session-catalog-result.js";

const dispatch = vi.hoisted(() => ({ request: vi.fn() }));
// mock-isolation: The archive step re-enters the Gateway router as the caller; observe that request.
vi.mock("../server-in-process-dispatch.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server-in-process-dispatch.js")>()),
  dispatchGatewayRequestInProcess: dispatch.request,
}));
import {
  call,
  hoisted,
  provider,
  resetSessionCatalogTestState,
} from "./session-catalog.test-helpers.js";

describe("sessions.catalog.move", () => {
  beforeEach(() => {
    resetSessionCatalogTestState();
    dispatch.request.mockReset();
  });

  it("rejects catalogs without a move hook", async () => {
    hoisted.activeRegistry.sessionCatalogs = [{ provider: provider("claude") }];

    const respond = await call("sessions.catalog.move", {
      catalogId: "claude",
      hostId: "gateway:local",
      threadId: "thread-1",
      group: "Home",
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: ErrorCodes.INVALID_REQUEST,
        message: "catalog cannot move",
      }),
    );
  });

  it("forwards the row, target folder and order with the resolved agent", async () => {
    const move = vi.fn<NonNullable<SessionCatalogProvider["move"]>>(async () => ({
      ok: true,
      threadId: "s:agent:beta:moved",
      sessionKey: "agent:beta:moved",
    }));
    hoisted.activeRegistry.sessionCatalogs = [{ provider: provider("claude", { move }) }];
    const config = { agents: { ownership: "explicit", entries: { alpha: {}, beta: {} } } };

    const respond = await call(
      "sessions.catalog.move",
      {
        catalogId: "claude",
        hostId: "gateway:local",
        agentId: "beta",
        threadId: "thread-1",
        group: "Home",
        threadIds: ["thread-2", "thread-1"],
      },
      config,
    );

    expect(respond).toHaveBeenCalledWith(true, {
      ok: true,
      threadId: "s:agent:beta:moved",
      sessionKey: "agent:beta:moved",
    });
    expect(move).toHaveBeenCalledWith({
      hostId: "gateway:local",
      agentId: "beta",
      allowProcessHomeFallback: expect.any(Boolean),
      threadId: "thread-1",
      group: "Home",
      threadIds: ["thread-2", "thread-1"],
    });
  });

  it("archives the superseded session as the caller and reports a failed archive as a warning", async () => {
    const move = vi.fn<NonNullable<SessionCatalogProvider["move"]>>(async () => ({
      ok: true,
      sessionKey: "agent:beta:moved",
      archive: { key: "agent:alpha:old", expectedSessionId: "sid-1" },
    }));
    hoisted.activeRegistry.sessionCatalogs = [{ provider: provider("claude", { move }) }];
    const request = {
      catalogId: "claude",
      hostId: "gateway:local",
      threadId: "t-1",
      group: "Home",
    };

    dispatch.request.mockResolvedValueOnce({ ok: true });
    const respond = await call("sessions.catalog.move", request);
    expect(dispatch.request).toHaveBeenCalledWith(
      "sessions.patch",
      { key: "agent:alpha:old", expectedSessionId: "sid-1", archived: true },
      expect.objectContaining({ requestIdPrefix: "catalog-move" }),
    );
    expect(respond).toHaveBeenCalledWith(true, { ok: true, sessionKey: "agent:beta:moved" });

    dispatch.request.mockRejectedValueOnce(new Error("Session agent:alpha:old is still active"));
    const partial = await call("sessions.catalog.move", request);
    expect(partial).toHaveBeenCalledWith(true, {
      ok: true,
      sessionKey: "agent:beta:moved",
      warning: expect.stringContaining(
        "agent:alpha:old was not archived: Session agent:alpha:old is still active",
      ),
    });
  });

  it("reports provider failures as catalog errors", async () => {
    const move = vi.fn(async () => {
      throw new Error("a main chat stays with its project");
    });
    hoisted.activeRegistry.sessionCatalogs = [{ provider: provider("claude", { move }) }];

    const respond = await call("sessions.catalog.move", {
      catalogId: "claude",
      hostId: "gateway:local",
      threadId: "thread-1",
      group: "Home",
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: ErrorCodes.INVALID_REQUEST,
        message: "a main chat stays with its project",
      }),
    );
  });

  it("advertises the move capability only for providers with the hook", () => {
    const move = async () => ({ ok: true as const });

    expect(catalogResult(provider("claude", { move }), undefined, []).capabilities).toEqual({
      continueSession: false,
      archive: false,
      move: true,
    });
    expect(catalogResult(provider("codex"), undefined, []).capabilities).toEqual({
      continueSession: false,
      archive: false,
    });
  });
});

describe("sessions.catalog.archive with a provider-named session", () => {
  beforeEach(() => {
    resetSessionCatalogTestState();
    dispatch.request.mockReset();
  });

  function setup(
    archiveResult: Awaited<ReturnType<NonNullable<SessionCatalogProvider["archive"]>>>,
  ) {
    const host = {
      hostId: "gateway:local",
      label: "Projects",
      kind: "gateway" as const,
      connected: true,
      sessions: [
        {
          threadId: "s:agent:beta:chat",
          sessionKey: "agent:beta:chat",
          status: "stored",
          archived: false,
          canContinue: true,
          canArchive: true,
        },
      ],
    };
    const archive = vi.fn(async () => archiveResult);
    hoisted.activeRegistry.sessionCatalogs = [
      { provider: provider("projects", { list: async () => [host], archive }) },
    ];
    return {
      archive,
      run: () =>
        call("sessions.catalog.archive", {
          catalogId: "projects",
          hostId: "gateway:local",
          threadId: "s:agent:beta:chat",
          confirmNoOtherRunner: true,
        }),
    };
  }

  it("archives the session as the caller and answers with the closed result", async () => {
    const { run } = setup({
      ok: true,
      archive: { key: "agent:beta:chat", expectedSessionId: "sid" },
    });
    dispatch.request.mockResolvedValueOnce({ ok: true });

    const respond = await run();

    expect(dispatch.request).toHaveBeenCalledWith(
      "sessions.patch",
      { key: "agent:beta:chat", expectedSessionId: "sid", archived: true },
      expect.objectContaining({ requestIdPrefix: "catalog-archive" }),
    );
    expect(respond).toHaveBeenCalledWith(true, { ok: true });
  });

  it("fails the request when the session cannot be archived", async () => {
    const { run } = setup({ ok: true, archive: { key: "agent:beta:chat" } });
    dispatch.request.mockRejectedValueOnce(new Error("Session agent:beta:chat is still active"));

    const respond = await run();

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "Session agent:beta:chat is still active" }),
    );
  });
});
