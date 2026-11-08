// Gateway widget storage methods: session-bound scope, validation, and error mapping.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCoreGatewayMethodDescriptors } from "../methods/core-method-policy.js";
import { canvasHandlers } from "./canvas.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

const storage = vi.hoisted(() => ({
  get: vi.fn(),
  list: vi.fn(),
  set: vi.fn(),
  delete: vi.fn(),
}));
vi.mock("../../canvas/widget-storage.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../canvas/widget-storage.js")>();
  return {
    ...actual,
    getWidgetStorageValue: storage.get,
    listWidgetStorageKeys: storage.list,
    setWidgetStorageValue: storage.set,
    deleteWidgetStorageValue: storage.delete,
  };
});

const { WidgetStorageError } = await import("../../canvas/widget-storage.js");

type StorageMethod =
  | "canvas.storage.get"
  | "canvas.storage.list"
  | "canvas.storage.set"
  | "canvas.storage.delete";

async function invoke(method: StorageMethod, params: unknown, config: object = {}) {
  const respond = vi.fn<RespondFn>();
  const commitGuard = vi.fn();
  await canvasHandlers[method]!({
    req: { type: "req", id: "storage", method, params },
    params,
    respond,
    sessionMutationCommitGuard: commitGuard,
    context: { getRuntimeConfig: () => config } as unknown as GatewayRequestContext,
  } as never);
  return { respond, commitGuard };
}

beforeEach(() => {
  storage.get.mockReset().mockResolvedValue("3");
  storage.list.mockReset().mockResolvedValue(["count"]);
  storage.set.mockReset().mockResolvedValue(undefined);
  storage.delete.mockReset().mockResolvedValue(true);
});

describe("canvas.storage methods", () => {
  it("scopes every operation to the canonical session and the named document", async () => {
    const scope = { sessionKey: "main", docId: "cv_counter" };
    const target = { docId: "cv_counter", scopeKey: "agent:main:main" };

    expect((await invoke("canvas.storage.get", { ...scope, key: "count" })).respond).toBeCalledWith(
      true,
      { value: "3" },
    );
    expect(storage.get).toBeCalledWith(target, "count");
    expect((await invoke("canvas.storage.list", { ...scope, prefix: "c" })).respond).toBeCalledWith(
      true,
      { keys: ["count"] },
    );
    expect(storage.list).toBeCalledWith(target, "c");
    const set = await invoke("canvas.storage.set", { ...scope, key: "count", value: "4" });
    expect(set.respond).toBeCalledWith(true, { ok: true });
    expect(set.commitGuard).toHaveBeenCalled();
    expect(storage.set).toBeCalledWith(target, "count", "4");
    expect(
      (await invoke("canvas.storage.delete", { ...scope, key: "count" })).respond,
    ).toBeCalledWith(true, { deleted: true });
    expect(storage.delete).toBeCalledWith(target, "count");
  });

  it.each([
    ["canvas.storage.get", { sessionKey: "main", docId: "../private", key: "k" }],
    ["canvas.storage.get", { sessionKey: "main", docId: "cv_x", key: "a/b" }],
    ["canvas.storage.get", { sessionKey: "main", docId: "cv_x", key: "a b" }],
    ["canvas.storage.get", { docId: "cv_x", key: "k" }],
    ["canvas.storage.get", { sessionKey: "main", docId: "cv_x", key: "k", scopeKey: "other" }],
    ["canvas.storage.set", { sessionKey: "main", docId: "cv_x", key: "k", value: 1 }],
    ["canvas.storage.list", { sessionKey: "main", docId: "cv_x", prefix: 1 }],
  ] as const)("rejects invalid %s params %j before touching storage", async (method, params) => {
    const { respond } = await invoke(method, params);
    expect(respond).toBeCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
    expect(storage.get).not.toHaveBeenCalled();
    expect(storage.set).not.toHaveBeenCalled();
    expect(storage.list).not.toHaveBeenCalled();
  });

  it("maps quota and retired-widget errors without exposing other failures", async () => {
    const params = { sessionKey: "main", docId: "cv_x", key: "k", value: "v" };
    storage.set.mockRejectedValueOnce(new WidgetStorageError("quota", "widget storage is full"));
    expect((await invoke("canvas.storage.set", params)).respond).toBeCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST", message: "widget storage is full" }),
    );
    storage.set.mockRejectedValueOnce(new WidgetStorageError("unavailable", "widget is gone"));
    expect((await invoke("canvas.storage.set", params)).respond).toBeCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "UNAVAILABLE", message: "widget is gone" }),
    );
    storage.set.mockRejectedValueOnce(new Error("EACCES: /state/canvas/widget-storage"));
    expect((await invoke("canvas.storage.set", params)).respond).toBeCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "UNAVAILABLE", message: "widget storage is unavailable" }),
    );
  });

  it("honors Canvas hosting disablement", async () => {
    const { respond } = await invoke(
      "canvas.storage.get",
      { sessionKey: "main", docId: "cv_x", key: "k" },
      { plugins: { entries: { canvas: { config: { host: { enabled: false } } } } } },
    );
    expect(respond).toBeCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "UNAVAILABLE" }),
    );
    expect(storage.get).not.toHaveBeenCalled();
  });

  it("registers reads as operator.read and writes as operator.write", () => {
    const descriptors = createCoreGatewayMethodDescriptors(canvasHandlers);
    expect(
      Object.fromEntries(
        descriptors
          .filter((entry) => entry.name.startsWith("canvas.storage."))
          .map((entry) => [entry.name, entry.scope]),
      ),
    ).toEqual({
      "canvas.storage.get": "operator.read",
      "canvas.storage.list": "operator.read",
      "canvas.storage.set": "operator.write",
      "canvas.storage.delete": "operator.write",
    });
  });
});
