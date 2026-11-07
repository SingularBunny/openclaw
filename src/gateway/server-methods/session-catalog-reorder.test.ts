import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import type { SessionCatalogProvider } from "../../plugins/session-catalog.js";
import { catalogResult } from "./session-catalog-result.js";
import {
  call,
  hoisted,
  provider,
  resetSessionCatalogTestState,
} from "./session-catalog.test-helpers.js";

describe("sessions.catalog.reorder", () => {
  beforeEach(resetSessionCatalogTestState);

  it("rejects catalogs without a reorder hook", async () => {
    hoisted.activeRegistry.sessionCatalogs = [{ provider: provider("claude") }];

    const respond = await call("sessions.catalog.reorder", {
      catalogId: "claude",
      hostId: "gateway:local",
      target: { kind: "groups", order: ["Work"] },
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: ErrorCodes.INVALID_REQUEST,
        message: "catalog cannot reorder",
      }),
    );
  });

  it("forwards the full order with the resolved agent to the provider", async () => {
    const reorder = vi.fn<NonNullable<SessionCatalogProvider["reorder"]>>(async () => ({
      ok: true,
    }));
    hoisted.activeRegistry.sessionCatalogs = [{ provider: provider("claude", { reorder }) }];
    const config = { agents: { ownership: "explicit", entries: { alpha: {}, beta: {} } } };
    const target = { kind: "sessions", group: "Work", threadIds: ["thread-2", "thread-1"] };

    const respond = await call(
      "sessions.catalog.reorder",
      { catalogId: "claude", hostId: "gateway:local", agentId: "beta", target },
      config,
    );

    expect(respond).toHaveBeenCalledWith(true, { ok: true });
    expect(reorder).toHaveBeenCalledOnce();
    expect(reorder).toHaveBeenCalledWith({
      hostId: "gateway:local",
      agentId: "beta",
      allowProcessHomeFallback: expect.any(Boolean),
      target,
    });
  });

  it("reports provider failures as catalog errors", async () => {
    const reorder = vi.fn(async () => {
      throw new Error("order store is read-only");
    });
    hoisted.activeRegistry.sessionCatalogs = [{ provider: provider("claude", { reorder }) }];

    const respond = await call("sessions.catalog.reorder", {
      catalogId: "claude",
      hostId: "gateway:local",
      target: { kind: "groups", order: ["Work", "Home"] },
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: ErrorCodes.INVALID_REQUEST,
        message: "order store is read-only",
      }),
    );
  });

  it("advertises the reorder capability only for providers with the hook", () => {
    const reorder = async () => ({ ok: true as const });

    expect(catalogResult(provider("claude", { reorder }), undefined, []).capabilities).toEqual({
      continueSession: false,
      archive: false,
      reorder: true,
    });
    expect(catalogResult(provider("codex"), undefined, []).capabilities).toEqual({
      continueSession: false,
      archive: false,
    });
  });
});
