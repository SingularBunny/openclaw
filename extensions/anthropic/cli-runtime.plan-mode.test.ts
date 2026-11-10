// Fork (F49): Claude CLI permission modes and ExitPlanMode approval over the stream-json protocol.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  CliBackendExecuteContext,
  CliBackendLiveSessionCapability,
  CliBackendLiveSessionHandle,
} from "openclaw/plugin-sdk/cli-backend";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLAUDE_CLI_PLAN_OPTIONS } from "./cli-permission-mode.js";
import { executeClaudeCli } from "./cli.runtime.js";

const roots: string[] = [];
const handles = new Set<CliBackendLiveSessionHandle>();
afterEach(async () => {
  for (const handle of handles) {
    handle.close("restart");
    await handle.waitForExit();
  }
  handles.clear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

// One native tool call per turn: the PreToolUse hook first, then can_use_tool, like Claude Code.
const fixture = String.raw`
import { createInterface } from "node:readline";
const send = (record) => process.stdout.write(JSON.stringify(record) + "\n");
const tool = process.env.FIXTURE_TOOL;
const toolInput = JSON.parse(process.env.FIXTURE_INPUT);
const modeRequests = [];
let turn = 0;
let hookDecision;
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.type === "control_request") {
    if (message.request.subtype === "set_permission_mode") modeRequests.push(message.request.mode);
    send({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: {} } });
  } else if (message.type === "user") {
    turn++;
    send({ type: "control_request", request_id: "pre-" + turn, request: { subtype: "hook_callback",
      callback_id: "PreToolUse", tool_use_id: "tool-" + turn, input: { hook_event_name: "PreToolUse",
        tool_name: tool, tool_input: toolInput, tool_use_id: "tool-" + turn, cwd: process.cwd() } } });
  } else if (message.type === "control_response") {
    const { request_id: id, response } = message.response;
    if (id === "pre-" + turn) {
      hookDecision = response;
      send({ type: "control_request", request_id: "permission-" + turn, request: { subtype: "can_use_tool",
        tool_name: tool, input: toolInput, tool_use_id: "tool-" + turn } });
    } else if (id === "permission-" + turn) {
      send({ type: "result", subtype: "success", session_id: "plan-fixture", num_turns: 1, stop_reason: "end_turn",
        result: JSON.stringify({ argv: process.argv.slice(2), hookDecision, permission: response, modeRequests }) });
    }
  }
}
`;

function createLiveSession(): CliBackendLiveSessionCapability {
  let current: CliBackendLiveSessionHandle | undefined;
  return {
    fingerprint: "plan-mode-fixture",
    current: () => current,
    restart: async () => {
      current?.close("restart");
      await current?.waitForExit();
    },
    register: (handle) => {
      current = handle;
      handles.add(handle);
    },
    activate: () => {},
    remove: (handle) => {
      if (current === handle) {
        current = undefined;
      }
    },
  };
}

async function run(
  tool: string,
  toolInput: Record<string, unknown>,
  overrides: Partial<CliBackendExecuteContext> = {},
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "openclaw-claude-plan-"));
  roots.push(root);
  const script = path.join(root, "claude.mjs");
  await writeFile(script, fixture);
  const context: CliBackendExecuteContext = {
    command: process.execPath,
    args: [script],
    cwd: root,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: root,
      FIXTURE_TOOL: tool,
      FIXTURE_INPUT: JSON.stringify(toolInput),
    },
    prompt: "plan the change",
    systemPrompt: "synthetic operator instructions",
    modelId: "claude-sonnet-4-6",
    useResume: false,
    liveSession: createLiveSession(),
    timeoutMs: 10_000,
    abortSignal: AbortSignal.timeout(10_000),
    requestToolPermission: vi.fn<CliBackendExecuteContext["requestToolPermission"]>(
      async (request) => ({ behavior: "allow", updatedInput: request.toolInput }),
    ),
    requestUserInput: vi.fn<CliBackendExecuteContext["requestUserInput"]>(async () => ({
      status: "cancelled",
      message: "No question expected.",
    })),
    ...overrides,
  };
  const records: Record<string, unknown>[] = [];
  for await (const record of executeClaudeCli(context)) {
    records.push(record);
  }
  const result = records.findLast((record) => record.type === "result");
  return {
    context,
    detail: JSON.parse(String(result?.result)) as {
      argv: string[];
      hookDecision: { hookSpecificOutput: Record<string, unknown> };
      permission: Record<string, unknown>;
      modeRequests: string[];
    },
  };
}

function modeArg(argv: string[]): string | undefined {
  return argv[argv.indexOf("--permission-mode") + 1];
}

const PLAN = { plan: "# Plan\n\n1. Change `fixture.txt`" };

function answering(answer: string) {
  return vi.fn<CliBackendExecuteContext["requestUserInput"]>(async () => ({
    status: "answered",
    answers: { plan_approval: [answer] },
  }));
}

describe("Claude CLI plan approval", () => {
  it.each([
    ["acceptEdits", CLAUDE_CLI_PLAN_OPTIONS.acceptEdits],
    ["default", CLAUDE_CLI_PLAN_OPTIONS.default],
  ] as const)("approves the plan and continues in %s", async (mode, answer) => {
    const requestUserInput = answering(answer);
    const onPermissionModeChange = vi.fn(async () => {});
    const { context, detail } = await run("ExitPlanMode", PLAN, {
      permissionMode: "plan",
      requestUserInput,
      onPermissionModeChange,
    });

    expect(modeArg(detail.argv)).toBe("plan");
    expect(detail.argv).toContain("--allow-dangerously-skip-permissions");
    expect(detail.hookDecision.hookSpecificOutput).toMatchObject({ permissionDecision: "allow" });
    expect(detail.permission).toMatchObject({
      behavior: "allow",
      updatedInput: PLAN,
      updatedPermissions: [{ type: "setMode", mode, destination: "session" }],
    });
    expect(detail.modeRequests).toEqual([mode]);
    expect(onPermissionModeChange).toHaveBeenCalledOnce();
    expect(onPermissionModeChange).toHaveBeenCalledWith(mode);
    // One card for the hook and can_use_tool; host approvals are not involved.
    expect(requestUserInput).toHaveBeenCalledOnce();
    expect(requestUserInput.mock.calls[0]?.[0]).toMatchObject({
      toolName: "ExitPlanMode",
      intro: expect.stringContaining("# Plan"),
      questions: [
        {
          id: "plan_approval",
          isOther: true,
          options: [
            { label: CLAUDE_CLI_PLAN_OPTIONS.acceptEdits },
            { label: CLAUDE_CLI_PLAN_OPTIONS.default },
            { label: CLAUDE_CLI_PLAN_OPTIONS.keepPlanning },
          ],
        },
      ],
    });
    expect(context.requestToolPermission).not.toHaveBeenCalled();
  });

  it.each([
    [CLAUDE_CLI_PLAN_OPTIONS.keepPlanning, "ask what to change"],
    ["Split the change into two commits", "Split the change into two commits"],
  ])("keeps planning on %j", async (answer, expected) => {
    const onPermissionModeChange = vi.fn(async () => {});
    const { detail } = await run("ExitPlanMode", PLAN, {
      permissionMode: "plan",
      requestUserInput: answering(answer),
      onPermissionModeChange,
    });

    expect(detail.hookDecision.hookSpecificOutput).toMatchObject({
      permissionDecision: "deny",
      permissionDecisionReason: expect.stringContaining(expected),
    });
    expect(detail.permission).toMatchObject({ behavior: "deny" });
    expect(detail.permission).not.toHaveProperty("updatedPermissions");
    expect(detail.modeRequests).toEqual([]);
    expect(onPermissionModeChange).not.toHaveBeenCalled();
  });

  it("leaves ExitPlanMode to host policy without an explicit session mode", async () => {
    const requestUserInput = answering(CLAUDE_CLI_PLAN_OPTIONS.acceptEdits);
    const { context, detail } = await run("ExitPlanMode", PLAN, { requestUserInput });

    expect(modeArg(detail.argv)).toBe("default");
    expect(detail.argv).not.toContain("--allow-dangerously-skip-permissions");
    expect(detail.permission).toMatchObject({ behavior: "allow", updatedInput: PLAN });
    expect(requestUserInput).not.toHaveBeenCalled();
    expect(context.requestToolPermission).toHaveBeenCalled();
    expect(vi.mocked(context.requestToolPermission).mock.calls[0]?.[0]).not.toHaveProperty(
      "requireApproval",
    );
  });
});

describe("Claude CLI permission mode gate", () => {
  const edit = { file_path: "fixture.txt", old_string: "a", new_string: "b" };

  it("refuses edits in plan mode before host policy", async () => {
    const { context, detail } = await run("Edit", edit, { permissionMode: "plan" });

    expect(detail.permission).toMatchObject({
      behavior: "deny",
      message: expect.stringContaining("Plan mode is on"),
    });
    expect(context.requestToolPermission).not.toHaveBeenCalled();
  });

  it.each([
    ["default", "Edit", edit, true],
    ["acceptEdits", "Edit", edit, false],
    ["acceptEdits", "Bash", { command: "ls" }, true],
    ["bypassPermissions", "Bash", { command: "ls" }, false],
  ] as const)("in %s asks for %s: %s", async (permissionMode, tool, input, ask) => {
    const { context, detail } = await run(tool, input, { permissionMode });

    expect(modeArg(detail.argv)).toBe(permissionMode);
    expect(detail.permission).toMatchObject({ behavior: "allow" });
    const request = vi.mocked(context.requestToolPermission).mock.calls[0]?.[0];
    expect(request?.toolName).toBe(tool);
    expect(request?.requireApproval === true).toBe(ask);
  });
});
