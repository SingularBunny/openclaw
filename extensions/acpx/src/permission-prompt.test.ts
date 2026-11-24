import { describe, expect, it, vi } from "vitest";
import {
  AcpxPermissionGrants,
  acpxAskSessionPermissions,
  acpxSettlesWithoutPrompt,
  createAcpxPermissionPromptBridge,
} from "./permission-prompt.js";
import { makeEmptySessionStore, makeRuntime, makeTurn } from "./runtime.test-support.js";

const sessionKey = "agent:junie:acp:test";
const options = [
  { optionId: "allow", name: "Allow", kind: "allow_once" as const },
  { optionId: "always", name: "Always allow", kind: "allow_always" as const },
  { optionId: "reject", name: "Reject", kind: "reject_once" as const },
];

function request(
  params: {
    kind?: string;
    title?: string;
    options?: typeof options;
    locations?: string[];
    rawInput?: unknown;
  } = {},
) {
  return {
    sessionId: "acp-session",
    inferredKind: (params.kind ?? "edit") as never,
    raw: {
      sessionId: "acp-session",
      toolCall: {
        toolCallId: "call-1",
        title: params.title ?? "Edit src/app.ts",
        rawInput: "rawInput" in params ? params.rawInput : { path: "src/app.ts" },
        ...(params.locations ? { locations: params.locations.map((path) => ({ path })) } : {}),
      },
      options: params.options ?? options,
    },
  } as unknown as Parameters<ReturnType<typeof createAcpxPermissionPromptBridge>>[0];
}

const context = () => ({ signal: new AbortController().signal });

function bridge(prompt?: Parameters<typeof createAcpxPermissionPromptBridge>[0]["prompt"]) {
  const log = vi.fn();
  const grants = new AcpxPermissionGrants();
  return {
    log,
    grants,
    handler: createAcpxPermissionPromptBridge({
      permissionMode: "approve-reads",
      sessionKey,
      prompt,
      grants,
      log,
    }),
  };
}

describe("acpx permission prompt bridge", () => {
  it.each([
    ["approve-all", "edit", true],
    ["deny-all", "execute", true],
    ["approve-reads", "read", true],
    ["approve-reads", "search", true],
    ["approve-reads", "edit", false],
    ["approve-reads", "execute", false],
  ] as const)("mode %s with %s settles without a prompt: %s", (mode, kind, expected) => {
    expect(acpxSettlesWithoutPrompt(request({ kind }), mode)).toBe(expected);
  });

  it("never lets the read rule answer an agent's own decision (plan review)", () => {
    const decision = request({
      kind: "read",
      title: "Implement this plan?",
      options: [
        { optionId: "implement", name: "Implement", kind: "allow_once" },
        { optionId: "stop", name: "Save the plan and stop", kind: "reject_once" },
      ] as unknown as typeof options,
    });
    expect(acpxSettlesWithoutPrompt(decision, "approve-reads")).toBe(false);
    expect(acpxSettlesWithoutPrompt(request({ kind: "read" }), "approve-reads")).toBe(true);
  });

  it.each([
    ["Allow viewing files?", "other"],
    ["Allow changes in this file?", "other"],
    ["git status", "execute"],
  ])("asks for %s (kind %s) under approve-reads", (title, kind) => {
    // How JetBrains Junie sends file access outside its project and terminal commands.
    expect(
      acpxSettlesWithoutPrompt(
        request({
          kind,
          title,
          options: [
            { optionId: "Yes", name: "Yes", kind: "allow_once" },
            { optionId: "No", name: "No", kind: "reject_once" },
          ] as unknown as typeof options,
        }),
        "approve-reads",
      ),
    ).toBe(false);
  });

  it("leaves requests acpx settles itself to acpx", async () => {
    const prompt = vi.fn();
    const { handler } = bridge(prompt);
    await expect(handler(request({ kind: "read" }), context())).resolves.toBeUndefined();
    await expect(handler(request({ options: [] }), context())).resolves.toBeUndefined();
    expect(prompt).not.toHaveBeenCalled();
  });

  it.each([
    ["allow", "allow"],
    ["always", "always"],
    ["reject", "reject"],
  ])("returns the option the user picked (%s)", async (picked, expected) => {
    const prompt = vi.fn(async () => ({ outcome: "selected" as const, optionId: picked }));
    const { handler } = bridge(prompt);
    await expect(handler(request(), context())).resolves.toEqual({
      outcome: "selected",
      optionId: expected,
    });
    expect(prompt).toHaveBeenCalledWith(
      {
        toolCallId: "call-1",
        title: "Edit src/app.ts",
        toolKind: "edit",
        rawInput: { path: "src/app.ts" },
        options,
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("remembers allow always for the same action in the session only", async () => {
    const prompt = vi.fn(async () => ({ outcome: "selected" as const, optionId: "always" }));
    const { handler, grants } = bridge(prompt);
    await handler(request(), context());
    await expect(handler(request(), context())).resolves.toEqual({
      outcome: "selected",
      optionId: "always",
    });
    expect(prompt).toHaveBeenCalledTimes(1);
    await handler(request({ title: "Edit src/other.ts" }), context());
    expect(prompt).toHaveBeenCalledTimes(2);
    grants.forget(sessionKey);
    await handler(request(), context());
    expect(prompt).toHaveBeenCalledTimes(3);
  });

  it("passes the files an action touches to the question", async () => {
    const prompt = vi.fn(async () => ({ outcome: "selected" as const, optionId: "allow" }));
    const { handler } = bridge(prompt);
    await handler(
      request({ kind: "other", title: "Allow viewing files?", locations: ["/repo/a.py"] }),
      context(),
    );
    expect(prompt).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Allow viewing files?", locations: ["/repo/a.py"] }),
      expect.anything(),
    );
  });

  it("does not carry allow always for a generic title over to other files", async () => {
    const prompt = vi.fn(async () => ({ outcome: "selected" as const, optionId: "always" }));
    const { handler } = bridge(prompt);
    const view = (path: string) =>
      request({ kind: "other", title: "Allow viewing files?", locations: [path], rawInput: {} });
    await handler(view("/repo/a.py"), context());
    await handler(view("/repo/a.py"), context());
    expect(prompt).toHaveBeenCalledTimes(1);
    await handler(view("/etc/shadow"), context());
    expect(prompt).toHaveBeenCalledTimes(2);
    await handler(request({ rawInput: { path: "src/other.ts" } }), context());
    expect(prompt).toHaveBeenCalledTimes(3);
  });

  it("does not remember allow once", async () => {
    const prompt = vi.fn(async () => ({ outcome: "selected" as const, optionId: "allow" }));
    const { handler } = bridge(prompt);
    await handler(request(), context());
    await handler(request(), context());
    expect(prompt).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["timeout", { outcome: "rejected", reason: "timeout", message: "timed out" }],
    ["unavailable", { outcome: "rejected", reason: "unavailable", message: "no chat" }],
    ["unknown option", { outcome: "selected", optionId: "made-up" }],
  ] as const)("rejects on %s", async (_name, decision) => {
    const { handler } = bridge(async () => decision);
    await expect(handler(request(), context())).resolves.toEqual({ outcome: "reject_once" });
  });

  it("rejects instead of failing when the turn has no chat to ask in", async () => {
    const { handler, log } = bridge(undefined);
    await expect(handler(request(), context())).resolves.toEqual({ outcome: "reject_once" });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("no chat to ask in"));
  });

  it("rejects when the question itself throws", async () => {
    const { handler, log } = bridge(async () => {
      throw new Error("gateway down");
    });
    await expect(handler(request(), context())).resolves.toEqual({ outcome: "reject_once" });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("gateway down"));
  });
});

describe("acpx ask session permissions", () => {
  it("lets the bridge own approve-reads prompts and denies outside a turn", async () => {
    const permissions = acpxAskSessionPermissions({
      permissionMode: "approve-reads",
      sessionKey,
      grants: new AcpxPermissionGrants(),
    });
    expect(permissions.permissionMode).toBe("approve-all");
    await expect(permissions.onPermissionRequest?.(request(), context())).resolves.toEqual({
      outcome: "reject_once",
    });
    await expect(
      permissions.onPermissionRequest?.(request({ kind: "read" }), context()),
    ).resolves.toBeUndefined();
  });

  it.each(["approve-all", "deny-all"] as const)("leaves %s to acpx", (permissionMode) => {
    expect(
      acpxAskSessionPermissions({ permissionMode, sessionKey, grants: new AcpxPermissionGrants() }),
    ).toEqual({});
  });
});

describe("acpx runtime permission prompt wiring", () => {
  const handle = { sessionKey, backend: "acpx", runtimeSessionName: sessionKey };

  async function startedTurnInput(
    runtimeOptions: Parameters<typeof makeRuntime>[1],
    extra: Record<string, unknown>,
  ) {
    const { runtime, delegate } = makeRuntime(makeEmptySessionStore(), runtimeOptions);
    const startTurn = vi.spyOn(delegate, "startTurn").mockImplementation(makeTurn);
    const turn = runtime.startTurn({
      handle,
      text: "Do work",
      mode: "prompt",
      requestId: "turn",
      ...extra,
    });
    await turn.result;
    return startTurn.mock.calls[0]?.[0] as Record<string, unknown>;
  }

  it("routes prompts to the turn's chat question when ask is configured", async () => {
    const onPermissionPrompt = vi.fn(async () => ({
      outcome: "selected" as const,
      optionId: "allow",
    }));
    const input = await startedTurnInput(
      { openclawPermissionPrompts: { permissionMode: "approve-reads" } },
      { onPermissionPrompt },
    );
    expect(input).not.toHaveProperty("onPermissionPrompt");
    const handler = input.onPermissionRequest as ReturnType<
      typeof createAcpxPermissionPromptBridge
    >;
    await expect(handler(request(), context())).resolves.toEqual({
      outcome: "selected",
      optionId: "allow",
    });
    expect(onPermissionPrompt).toHaveBeenCalledTimes(1);
  });

  it("keeps acpx's own policy when ask is not configured", async () => {
    const input = await startedTurnInput({}, { onPermissionPrompt: vi.fn() });
    expect(input).not.toHaveProperty("onPermissionRequest");
  });

  it("keeps a caller's own acpx permission handler", async () => {
    const own = vi.fn();
    const input = await startedTurnInput(
      { openclawPermissionPrompts: { permissionMode: "approve-reads" } },
      { onPermissionRequest: own },
    );
    expect(input.onPermissionRequest).toBe(own);
  });
});
