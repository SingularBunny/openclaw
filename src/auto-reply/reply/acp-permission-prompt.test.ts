import type { AcpPermissionPromptRequest } from "@openclaw/acp-core/runtime/types";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_EXEC_APPROVAL_TIMEOUT_MS } from "../../infra/exec-approvals-core.js";
import { createUnavailableAcpPermissionPromptHandler } from "./acp-permission-prompt-unavailable.js";
import {
  ACP_PERMISSION_PROMPT_TIMEOUT_MS,
  buildAcpPermissionQuestion,
  createAcpPermissionPromptHandler,
} from "./acp-permission-prompt.js";

type Ask = NonNullable<Parameters<typeof createAcpPermissionPromptHandler>[0]["askQuestion"]>;
type AskResult = Awaited<ReturnType<Ask>>;

const request: AcpPermissionPromptRequest = {
  toolCallId: "call-1",
  title: "Run npm test",
  toolKind: "execute",
  rawInput: { command: "npm test" },
  options: [
    { optionId: "allow-id", name: "Allow", kind: "allow_once" },
    { optionId: "always-id", name: "Always", kind: "allow_always" },
    { optionId: "reject-id", name: "Reject", kind: "reject_once" },
    { optionId: "never-id", name: "Never", kind: "reject_always" },
  ],
};

function answered(answer: string): AskResult {
  return { status: "answered", answers: { answers: { permission: [answer] } } } as AskResult;
}

function setup(
  ask: Ask,
  overrides: { deliver?: (payload: unknown) => Promise<boolean>; active?: boolean } = {},
) {
  const deliver = vi.fn(overrides.deliver ?? (async () => true));
  const handler = createAcpPermissionPromptHandler({
    sessionKey: "agent:main:telegram:direct:1",
    outerRequestId: "req-1",
    agentLabel: "junie",
    delivery: { deliver: async (_kind, payload) => await deliver(payload) },
    isActive: () => overrides.active ?? true,
    askQuestion: ask,
  });
  return { handler, deliver };
}

const context = () => ({ signal: new AbortController().signal });

describe("ACP permission prompt", () => {
  it("uses the exec approval timeout", () => {
    expect(ACP_PERMISSION_PROMPT_TIMEOUT_MS).toBe(DEFAULT_EXEC_APPROVAL_TIMEOUT_MS);
  });

  it("asks one question with a button per ACP option", () => {
    const question = buildAcpPermissionQuestion({
      request,
      agentLabel: "junie",
      timeoutMs: ACP_PERMISSION_PROMPT_TIMEOUT_MS,
    });
    expect(question.options).toEqual([
      { label: "Allow once", value: "allow-id" },
      { label: "Allow always", value: "always-id" },
      { label: "Deny", value: "reject-id" },
      { label: "Deny always", value: "never-id" },
    ]);
    expect(question.question).toContain("junie asks for permission: Run npm test (execute)");
    expect(question.question).toContain("npm test");
    expect(question.question).toContain("No answer within 30 minutes denies it.");
    expect(question.header.length).toBeLessThanOrEqual(12);
  });

  it("passes the question to the Gateway question service with the exec timeout", async () => {
    const ask = vi.fn<Ask>(async () => answered("allow-id"));
    const { handler } = setup(ask);
    await handler(request, context());
    expect(ask).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:telegram:direct:1",
        timeoutMs: DEFAULT_EXEC_APPROVAL_TIMEOUT_MS,
        questionId: expect.stringMatching(/^acpperm_/),
      }),
    );
  });

  it.each([
    ["allow-id", "allow-id"],
    ["always-id", "always-id"],
    ["reject-id", "reject-id"],
    ["never-id", "never-id"],
    ["Allow always", "always-id"],
    ["deny", "reject-id"],
  ])("maps the answer %s to ACP option %s", async (answer, optionId) => {
    const { handler, deliver } = setup(async () => answered(answer));
    await expect(handler(request, context())).resolves.toEqual({ outcome: "selected", optionId });
    expect(deliver).not.toHaveBeenCalled();
  });

  it("denies an answer that matches no button and says so", async () => {
    const { handler, deliver } = setup(async () => answered("maybe"));
    await expect(handler(request, context())).resolves.toMatchObject({
      outcome: "rejected",
      reason: "cancelled",
    });
    expect(deliver).toHaveBeenCalledWith({ text: expect.stringContaining("matches no button") });
  });

  it("denies on timeout and tells the user what to do", async () => {
    const { handler, deliver } = setup(async () => ({ status: "expired" }) as AskResult);
    const decision = await handler(request, context());
    expect(decision).toMatchObject({ outcome: "rejected", reason: "timeout" });
    const text = String((deliver.mock.calls[0]?.[0] as { text?: string } | undefined)?.text);
    expect(text).toContain("timed out: no answer within 30 minutes");
    expect(text).toContain("continues without it");
    expect(text).toContain("permissionMode to approve-all");
  });

  it("denies when the chat cannot show the question, without throwing", async () => {
    const ask: Ask = async (params) => {
      await params.delivery.onBlockReply?.({ text: "question" });
      return answered("allow-id");
    };
    const { handler, deliver } = setup(ask, { deliver: async () => false });
    const decision = await handler(request, context());
    expect(decision).toMatchObject({ outcome: "rejected", reason: "unavailable" });
    expect(deliver).toHaveBeenLastCalledWith({
      text: expect.stringContaining("Could not ask for permission in this chat"),
    });
  });

  it("denies when the question service fails", async () => {
    const { handler } = setup(async () => {
      throw new Error("session already has a pending agent input request");
    });
    await expect(handler(request, context())).resolves.toMatchObject({
      outcome: "rejected",
      reason: "unavailable",
      message: expect.stringContaining("pending agent input request"),
    });
  });

  it("does not ask once the turn has ended", async () => {
    const ask = vi.fn<Ask>();
    const controller = new AbortController();
    controller.abort();
    const { handler } = setup(ask);
    await expect(handler(request, { signal: controller.signal })).resolves.toMatchObject({
      outcome: "rejected",
      reason: "cancelled",
    });
    const inactive = setup(ask, { active: false });
    await expect(inactive.handler(request, context())).resolves.toMatchObject({
      reason: "cancelled",
    });
    expect(ask).not.toHaveBeenCalled();
  });

  it("denies at once with a notice when the run has no chat", async () => {
    const notify = vi.fn();
    const handler = createUnavailableAcpPermissionPromptHandler({ agentLabel: "junie", notify });
    await expect(handler(request, context())).resolves.toMatchObject({
      outcome: "rejected",
      reason: "unavailable",
    });
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("no chat to ask in"));
  });
});
