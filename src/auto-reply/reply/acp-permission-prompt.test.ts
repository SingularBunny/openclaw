import type { AcpPermissionPromptRequest } from "@openclaw/acp-core/runtime/types";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_EXEC_APPROVAL_TIMEOUT_MS } from "../../infra/exec-approvals-core.js";
import { createUnavailableAcpPermissionPromptHandler } from "./acp-permission-prompt-unavailable.js";
import {
  ACP_PERMISSION_PROMPT_TIMEOUT_MS,
  buildAcpPermissionQuestion,
  buildAcpPermissionQuestionOptions,
  createAcpPermissionPromptHandler,
  describeAcpPermissionOptionScope,
  isAcpDecisionRequest,
  renderAcpPermissionInput,
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
  overrides: {
    deliver?: (payload: unknown) => Promise<boolean>;
    active?: boolean;
    sessionKey?: string;
  } = {},
) {
  const deliver = vi.fn(overrides.deliver ?? (async () => true));
  const handler = createAcpPermissionPromptHandler({
    sessionKey: overrides.sessionKey ?? "agent:main:telegram:direct:1",
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

  // Fork: "Allow all in this chat" when the backend can switch the session to allow all.
  it("offers Allow all in this chat for a permission request the backend can allow all of", () => {
    const question = buildAcpPermissionQuestion({
      request: { ...request, allowAllOffered: true },
      agentLabel: "junie",
      timeoutMs: ACP_PERMISSION_PROMPT_TIMEOUT_MS,
    });
    expect(question.options?.at(-1)).toEqual({
      label: "Allow all in this chat",
      value: "openclaw:allow-all",
      description: expect.stringContaining("every later permission request of junie"),
    });
    const decision = buildAcpPermissionQuestion({
      request: {
        ...request,
        allowAllOffered: true,
        options: [
          { optionId: "implement", name: "Implement", kind: "allow_once" },
          { optionId: "stop", name: "Save the plan and stop", kind: "reject_once" },
        ],
      },
      agentLabel: "junie",
      timeoutMs: ACP_PERMISSION_PROMPT_TIMEOUT_MS,
    });
    expect(decision.options?.map((option) => option.value)).toEqual(["implement", "stop"]);
    const denyOnly = buildAcpPermissionQuestion({
      request: { ...request, allowAllOffered: true, options: request.options.slice(2) },
      agentLabel: "junie",
      timeoutMs: ACP_PERMISSION_PROMPT_TIMEOUT_MS,
    });
    expect(denyOnly.options?.map((option) => option.value)).toEqual(["reject-id", "never-id"]);
  });

  it.each([
    ["the button", "openclaw:allow-all", "allow-id"],
    ["its label typed", "allow all in this chat", "allow-id"],
  ])(
    "answers Allow all in this chat (%s) with an allow option",
    async (_name, answer, optionId) => {
      const { handler } = setup(async () => answered(answer));
      await expect(handler({ ...request, allowAllOffered: true }, context())).resolves.toEqual({
        outcome: "selected",
        optionId,
        allowAll: true,
      });
      const alwaysOnly = setup(async () => answered(answer)).handler;
      await expect(
        alwaysOnly(
          { ...request, allowAllOffered: true, options: request.options.slice(1) },
          context(),
        ),
      ).resolves.toEqual({ outcome: "selected", optionId: "always-id", allowAll: true });
    },
  );

  it("labels buttons by kind and moves the agent's scope wording to the description", () => {
    // The shape a JetBrains Junie read outside its project arrives in (vendor-neutral kinds).
    expect(
      buildAcpPermissionQuestionOptions([
        { optionId: "Yes", name: "Yes", kind: "allow_once" },
        { optionId: "Always", name: 'Always allow ("/repo/*")', kind: "allow_always" },
        { optionId: "No", name: "No", kind: "reject_once" },
      ]),
    ).toEqual([
      { label: "Allow once", value: "Yes" },
      { label: "Allow always", value: "Always", description: "/repo/*" },
      { label: "Deny", value: "No" },
    ]);
  });

  it("names the scope in the label when one kind is offered twice, without repeating text", () => {
    const labels = buildAcpPermissionQuestionOptions([
      { optionId: "once", name: "Allow", kind: "allow_once" },
      { optionId: "always", name: "Always allow", kind: "allow_always" },
      { optionId: "dir", name: 'Always allow ("/repo/src/*")', kind: "allow_always" },
      { optionId: "no", name: "Reject", kind: "reject_once" },
    ]).map((option) => option.label);
    expect(labels).toEqual(["Allow once", "Allow always", "Allow always: /repo/src/*", "Deny"]);
    for (const label of labels) {
      expect(label).not.toMatch(/always allow/i);
    }
  });

  it.each([
    ["Allow", undefined],
    ["Always", undefined],
    ["Allow once", undefined],
    ["Reject always", undefined],
    ["Yes", undefined],
    ['Always allow ("/repo/*")', "/repo/*"],
    ["Allow for this session", "for this session"],
  ])("reads the scope of option %s as %s", (name, scope) => {
    expect(describeAcpPermissionOptionScope(name)).toBe(scope);
  });

  it("names the files an action touches and drops the uninformative kind", () => {
    const question = buildAcpPermissionQuestion({
      request: {
        toolCallId: "call-2",
        title: "Allow viewing files?",
        toolKind: "other",
        locations: ["/repo/tools/check.py"],
        options: request.options,
      },
      agentLabel: "junie",
      timeoutMs: ACP_PERMISSION_PROMPT_TIMEOUT_MS,
    });
    expect(question.question).toContain("junie asks for permission: Allow viewing files?\n");
    expect(question.question).not.toContain("(other)");
    expect(question.question).toContain("File:\n/repo/tools/check.py");
  });

  it("asks concurrent requests of one chat one after another, each on its own", async () => {
    const order: string[] = [];
    const answers: Array<(result: AskResult) => void> = [];
    const ask = vi.fn<Ask>(async (params) => {
      order.push(`ask ${params.questionId?.slice(0, 8)}`);
      return await new Promise<AskResult>((resolve) => {
        answers.push(resolve);
      });
    });
    const { handler } = setup(ask);
    const first = handler(request, context());
    const second = handler({ ...request, toolCallId: "call-2" }, context());
    await vi.waitFor(() => expect(ask).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(ask).toHaveBeenCalledTimes(1);
    answers[0]?.(answered("always-id"));
    await expect(first).resolves.toEqual({ outcome: "selected", optionId: "always-id" });
    await vi.waitFor(() => expect(ask).toHaveBeenCalledTimes(2));
    answers[1]?.(answered("reject-id"));
    await expect(second).resolves.toEqual({ outcome: "selected", optionId: "reject-id" });
    const ids = ask.mock.calls.map(([params]) => params.questionId);
    expect(new Set(ids).size).toBe(2);
  });

  it("drops a queued request when its turn ends, and other chats are not held up", async () => {
    let answerFirst: ((result: AskResult) => void) | undefined;
    const ask = vi.fn<Ask>(
      async () =>
        await new Promise<AskResult>((resolve) => {
          answerFirst ??= resolve;
        }),
    );
    const { handler } = setup(ask, { sessionKey: "agent:main:dashboard:queue" });
    const first = handler(request, context());
    const controller = new AbortController();
    const queued = handler(request, { signal: controller.signal });
    controller.abort();
    await expect(queued).resolves.toMatchObject({ outcome: "rejected", reason: "cancelled" });
    const other = setup(async () => answered("allow-id"), {
      sessionKey: "agent:main:dashboard:other",
    });
    await expect(other.handler(request, context())).resolves.toEqual({
      outcome: "selected",
      optionId: "allow-id",
    });
    answerFirst?.(answered("allow-id"));
    await expect(first).resolves.toMatchObject({ outcome: "selected" });
    expect(ask).toHaveBeenCalledTimes(1);
  });

  // The shape of a JetBrains Junie plan review sent as session/request_permission.
  const plan = [
    "# Plan",
    "",
    "1. Read the parser.",
    "2. Add the cache.",
    ...Array.from({ length: 40 }, (_, i) => `- step ${i}: details that make the plan long`),
  ].join("\n");
  const planRequest: AcpPermissionPromptRequest = {
    toolCallId: "plan-1",
    title: "Implement this plan?",
    toolKind: "other",
    rawInput: { plan },
    options: [
      { optionId: "implement", name: "Implement", kind: "allow_once" },
      { optionId: "spawn-agentic-team", name: "Spawn agentic team", kind: "allow_once" },
      { optionId: "revise", name: "Revise", kind: "reject_once" },
      { optionId: "stop", name: "Save the plan and stop", kind: "reject_once" },
    ],
  };

  it("shows a decision with the agent's own option names, not Allow/Deny", () => {
    expect(isAcpDecisionRequest(planRequest.options)).toBe(true);
    expect(isAcpDecisionRequest(request.options)).toBe(false);
    const question = buildAcpPermissionQuestion({
      request: planRequest,
      agentLabel: "junie",
      timeoutMs: ACP_PERMISSION_PROMPT_TIMEOUT_MS,
      detailShownAbove: true,
    });
    expect(question.options).toEqual([
      { label: "Implement", value: "implement" },
      { label: "Spawn agentic team", value: "spawn-agentic-team" },
      { label: "Revise", value: "revise" },
      { label: "Save the plan and stop", value: "stop" },
    ]);
    expect(question.header).toBe("Decision");
    expect(question.question).toContain("junie asks: Implement this plan?");
    expect(question.question).not.toContain("permission");
    expect(question.question).toContain("The full text is in the message above.");
  });

  it.each([
    [
      "step limit",
      [
        { optionId: "stop", name: "Stop", kind: "reject_once" },
        { optionId: "continue", name: "Continue", kind: "allow_once" },
      ],
      ["Stop", "Continue"],
    ],
    [
      "terminal command with an allowlist entry",
      [
        { optionId: "Yes", name: "Yes", kind: "allow_once" },
        { optionId: "git", name: "Always allow (git status)", kind: "allow_always" },
        { optionId: "No", name: "No", kind: "reject_once" },
      ],
      ["Allow once", "Allow always", "Deny"],
    ],
  ])("labels a %s request", (_name, options, labels) => {
    expect(buildAcpPermissionQuestionOptions(options).map((option) => option.label)).toEqual(
      labels,
    );
  });

  it("renders tool input as text, not escaped JSON", () => {
    expect(renderAcpPermissionInput({ plan: "# Plan\n\n1. Do it" })).toBe("# Plan\n\n1. Do it");
    expect(renderAcpPermissionInput({ command: "npm test", cwd: "/repo" })).toBe(
      "command: npm test\n\ncwd: /repo",
    );
    expect(renderAcpPermissionInput("rm -rf build")).toBe("rm -rf build");
    expect(renderAcpPermissionInput({})).toBeUndefined();
  });

  it("posts a long plan in full as a message before asking, then maps the chosen name", async () => {
    const order: string[] = [];
    const ask = vi.fn<Ask>(async () => {
      order.push("ask");
      return answered("Spawn agentic team");
    });
    const { handler, deliver } = setup(ask, {
      deliver: async (payload) => {
        order.push("message");
        expect((payload as { text: string }).text).toContain(plan);
        return true;
      },
    });
    await expect(handler(planRequest, context())).resolves.toEqual({
      outcome: "selected",
      optionId: "spawn-agentic-team",
    });
    expect(order).toEqual(["message", "ask"]);
    expect(deliver).toHaveBeenCalledTimes(1);
    const asked = ask.mock.calls[0]?.[0].questions[0]?.question ?? "";
    expect(asked).toContain("The full text is in the message above.");
    expect(asked).not.toContain('{"plan"');
  });

  it("keeps a long plan readable in the question when the message cannot be posted", () => {
    const question = buildAcpPermissionQuestion({
      request: planRequest,
      agentLabel: "junie",
      timeoutMs: ACP_PERMISSION_PROMPT_TIMEOUT_MS,
    });
    expect(question.question).toContain("# Plan\n\n1. Read the parser.");
    expect(question.question).not.toContain('{"plan"');
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
