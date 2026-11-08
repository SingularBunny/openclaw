import { describe, expect, it, vi } from "vitest";
import {
  handleWidgetStorageRequest,
  serveWidgetStorageRequest,
  WidgetStorageFailureNotice,
} from "./widget-storage-bridge.ts";

function scope(docId = "cv_counter") {
  return {
    client: { request: vi.fn().mockResolvedValue({ value: "2" }) },
    sessionKey: "agent:main:main",
    docId,
  };
}

const request = (method: string, params: unknown, id = "storage-1") => ({
  type: "openclaw:widget-storage-request",
  id,
  method,
  params,
});

describe("widget storage bridge", () => {
  it("binds the session and document from the host, never from widget params", async () => {
    const current = scope();
    const response = await handleWidgetStorageRequest(
      request("set", {
        key: "count",
        value: "3",
        sessionKey: "agent:main:other",
        docId: "cv_other",
        extra: true,
      }),
      current,
    );
    expect(current.client.request).toHaveBeenCalledWith("canvas.storage.set", {
      sessionKey: "agent:main:main",
      docId: "cv_counter",
      key: "count",
      value: "3",
    });
    expect(response).toEqual({
      type: "openclaw:widget-storage-response",
      id: "storage-1",
      ok: true,
      result: { value: "2" },
    });
  });

  it("forwards only the fields each operation accepts", async () => {
    const current = scope();
    await handleWidgetStorageRequest(request("list", { prefix: "todo:", key: "x" }), current);
    await handleWidgetStorageRequest(request("delete", { key: "count", value: "x" }), current);
    expect(current.client.request.mock.calls).toEqual([
      [
        "canvas.storage.list",
        { sessionKey: "agent:main:main", docId: "cv_counter", prefix: "todo:" },
      ],
      [
        "canvas.storage.delete",
        { sessionKey: "agent:main:main", docId: "cv_counter", key: "count" },
      ],
    ]);
  });

  it("ignores other messages and answers malformed, unscoped, or failed requests", async () => {
    const current = scope();
    expect(await handleWidgetStorageRequest({ type: "openclaw:widget-prompt" }, current)).toBe(
      undefined,
    );
    expect(await handleWidgetStorageRequest(request("get", {}, ""), current)).toBe(undefined);
    expect(await handleWidgetStorageRequest(request("clear", {}), current)).toMatchObject({
      ok: false,
      error: "widget storage request is invalid",
    });
    expect(await handleWidgetStorageRequest(request("get", { key: "k" }), undefined)).toMatchObject(
      { ok: false, error: "widget storage unavailable" },
    );
    current.client.request.mockRejectedValueOnce(new Error("widget storage is limited"));
    expect(await handleWidgetStorageRequest(request("get", { key: "k" }), current)).toMatchObject({
      ok: false,
      error: "widget storage is limited",
    });
  });

  it("rate-limits a runaway widget per document", async () => {
    const current = scope("cv_runaway");
    const results = [];
    for (let index = 0; index < 601; index += 1) {
      results.push(await handleWidgetStorageRequest(request("get", { key: "k" }), current));
    }
    expect(results.at(-1)).toMatchObject({
      ok: false,
      error: "widget storage rate limit exceeded",
    });
    expect(current.client.request).toHaveBeenCalledTimes(600);
    const other = scope("cv_other_widget");
    expect(await handleWidgetStorageRequest(request("get", { key: "k" }), other)).toMatchObject({
      ok: true,
    });
  });

  it("rejects non-string values before they reach the Gateway", async () => {
    const current = scope();
    expect(
      await handleWidgetStorageRequest(request("set", { key: "count", value: null }), current),
    ).toMatchObject({ ok: false, error: "widget storage values must be strings" });
    expect(current.client.request).not.toHaveBeenCalled();
  });

  it("explains why an unscoped widget cannot use storage", async () => {
    expect(
      await handleWidgetStorageRequest(
        request("get", { key: "k" }),
        undefined,
        "Gateway is disconnected",
      ),
    ).toMatchObject({ ok: false, error: "Gateway is disconnected" });
  });
});

describe("widget storage failure notice", () => {
  const notice = () => {
    const onChange = vi.fn();
    const tracker = new WidgetStorageFailureNotice(
      (kind, reason) => `${kind === "save" ? "not saved" : "not loaded"}: ${reason}`,
      onChange,
    );
    return { tracker, onChange };
  };

  it("shows one notice per failure and coalesces repeats", () => {
    const { tracker, onChange } = notice();
    tracker.record("get", { ok: true, result: { value: null } } as never);
    expect(tracker.message).toBe("");
    for (let index = 0; index < 5; index += 1) {
      tracker.record("set", { ok: false, error: "quota" });
    }
    expect(tracker.message).toBe("not saved: quota");
    expect(onChange).toHaveBeenCalledTimes(1);
    tracker.record("list", { ok: false, error: "Gateway is disconnected" });
    expect(tracker.message).toBe("not loaded: Gateway is disconnected");
  });

  it("keeps a dismissed failure hidden until a write succeeds", () => {
    const { tracker } = notice();
    tracker.record("delete", { ok: false, error: "rate limit" });
    tracker.dismiss();
    expect(tracker.message).toBe("");
    tracker.record("delete", { ok: false, error: "rate limit" });
    expect(tracker.message).toBe("");
    tracker.record("set", { ok: false, error: "quota" });
    expect(tracker.message).toBe("not saved: quota");
    tracker.record("get", { ok: true });
    expect(tracker.message).toBe("not saved: quota");
    tracker.record("set", { ok: true });
    expect(tracker.message).toBe("");
    tracker.record("delete", { ok: false, error: "rate limit" });
    expect(tracker.message).toBe("not saved: rate limit");
  });

  it("explains a widget without a session and skips stale ports", async () => {
    const { tracker } = notice();
    const reply = vi.fn(() => true);
    serveWidgetStorageRequest(request("set", { key: "k", value: "v" }), {
      scope: undefined,
      hasSession: false,
      connected: true,
      notice: tracker,
      reply,
    });
    await vi.waitFor(() => expect(reply).toHaveBeenCalledOnce());
    expect(tracker.message).toBe("not saved: widget storage is not available for this widget");

    const stale = new WidgetStorageFailureNotice(() => "shown", vi.fn());
    const staleReply = vi.fn(() => false);
    serveWidgetStorageRequest(request("set", { key: "k", value: "v" }), {
      scope: undefined,
      hasSession: true,
      connected: false,
      notice: stale,
      reply: staleReply,
    });
    await vi.waitFor(() =>
      expect(staleReply).toHaveBeenCalledWith(
        expect.objectContaining({ ok: false, error: "Gateway is disconnected" }),
      ),
    );
    expect(stale.message).toBe("");
  });

  it("ignores port messages that are not storage responses", () => {
    const { tracker, onChange } = notice();
    tracker.recordResponse({ type: "openclaw:widget-prompt" }, undefined);
    expect(onChange).not.toHaveBeenCalled();
  });
});
