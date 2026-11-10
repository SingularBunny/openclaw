// Fork (F49): the session's Claude CLI mode reaches the plugin and can require an approval.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { CliBackendExecuteContext } from "../../plugins/cli-backend.types.js";
import { callGatewayTool } from "../tools/gateway.js";
import {
  closePluginTestAdmissions,
  createExecution,
  runPlugin,
  SUCCESS_RESULT,
} from "./execute-plugin.test-support.js";

vi.mock("../tools/gateway.js", () => ({
  callGatewayTool: vi.fn(),
}));

const mockCallGatewayTool = vi.mocked(callGatewayTool);

afterEach(() => {
  closePluginTestAdmissions();
  mockCallGatewayTool.mockReset();
  vi.restoreAllMocks();
});

async function runWith(
  sessionEntry: SessionEntry,
  body: (execution: CliBackendExecuteContext) => Promise<void>,
) {
  const { context } = await createExecution({ sessionEntry, nativeTools: ["WebFetch"] });
  await runPlugin(context, async function* (execution) {
    await body(execution);
    yield SUCCESS_RESULT;
  });
}

describe("Claude CLI permission mode in plugin execution", () => {
  it("passes no mode for sessions without a choice", async () => {
    let seen: CliBackendExecuteContext | undefined;
    await runWith({ sessionId: "sdk-session", updatedAt: 1 }, async (execution) => {
      seen = execution;
    });
    expect(seen?.permissionMode).toBeUndefined();
    expect(typeof seen?.onPermissionModeChange).toBe("function");
  });

  it("passes the stored session mode", async () => {
    let mode: string | undefined;
    await runWith(
      { sessionId: "sdk-session", updatedAt: 1, claudePermissionMode: "plan" },
      async (execution) => {
        mode = execution.permissionMode;
      },
    );
    expect(mode).toBe("plan");
  });

  it("asks under exec full when the mode requires approval, and not otherwise", async () => {
    mockCallGatewayTool.mockResolvedValueOnce({ id: "approval-1", decision: "allow-once" });
    const decisions: unknown[] = [];
    await runWith({ sessionId: "sdk-session", updatedAt: 1 }, async (execution) => {
      const input = { url: "https://example.com" };
      decisions.push(
        await execution.requestToolPermission({
          toolName: "WebFetch",
          toolInput: input,
          toolCallId: "native-silent",
        }),
      );
      decisions.push(
        await execution.requestToolPermission({
          toolName: "WebFetch",
          toolInput: input,
          toolCallId: "native-asked",
          requireApproval: true,
        }),
      );
    });

    expect(decisions).toEqual([
      { behavior: "allow", updatedInput: { url: "https://example.com" } },
      { behavior: "allow", updatedInput: { url: "https://example.com" } },
    ]);
    expect(mockCallGatewayTool).toHaveBeenCalledOnce();
    expect(mockCallGatewayTool.mock.calls[0]?.[0]).toBe("plugin.approval.request");
    expect(mockCallGatewayTool.mock.calls[0]?.[2]).toMatchObject({
      toolName: "WebFetch",
      toolCallId: "native-asked",
      allowedDecisions: ["allow-once", "allow-always", "deny"],
    });
  });

  it("keeps a host denial when the mode asks", async () => {
    const { context } = await createExecution({
      config: { tools: { exec: { security: "deny", ask: "off" } } },
      nativeTools: ["WebFetch"],
    });
    let decision: unknown;
    await runPlugin(context, async function* (execution) {
      decision = await execution.requestToolPermission({
        toolName: "WebFetch",
        toolInput: { url: "https://example.com" },
        requireApproval: true,
      });
      yield SUCCESS_RESULT;
    });
    expect(decision).toMatchObject({ behavior: "deny" });
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
  });
});
