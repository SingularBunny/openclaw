import { expect, it, onTestFinished, vi } from "vitest";
import { clearAgentRunContext, registerAgentRunContext } from "../infra/agent-run-registry.js";
import type { RunExit } from "../process/supervisor/types.js";
import {
  enqueueSessionEventMock,
  enqueueSystemEventMock,
  supervisorSpawnMock,
  type createManagedRun,
} from "./cli-runner.test-support.js";
import type { PreparedCliRunContext } from "./cli-runner/types.js";
import type { EmbeddedAgentRunResult } from "./embedded-agent-runner/types.js";

/** Runs watchdog notice checks inside the reliability suite's admitted process fixture. */
export function registerCliWatchdogNoticeTests(fixture: {
  createContext: (params: {
    sessionKey: string;
    runId: string;
    cliSessionId: string;
    openClawHistoryPrompt: string;
  }) => PreparedCliRunContext;
  makeManagedRun: (overrides?: Partial<RunExit>) => ReturnType<typeof createManagedRun>;
  run: (context: PreparedCliRunContext) => Promise<EmbeddedAgentRunResult>;
  historyPrompt: string;
}) {
  it.each(["automatic", "message_tool_only", "private-run"] as const)(
    "leaves a passive watchdog notice under %s delivery without waking the agent or retrying after diagnostic output",
    async (policy) => {
      enqueueSessionEventMock.mockClear();
      enqueueSystemEventMock.mockClear();
      const clearBeforeRetry = vi.fn(async () => true);
      supervisorSpawnMock.mockResolvedValueOnce(
        fixture.makeManagedRun({
          reason: "no-output-timeout",
          exitCode: null,
          exitSignal: "SIGKILL",
          durationMs: 500,
          stdout: "partial progress before the stall",
          timedOut: true,
          noOutputTimedOut: true,
        }),
      );
      const runId = `run-timeout-after-output-${policy}`;
      if (policy === "private-run") {
        registerAgentRunContext(runId, { sessionEventDelivery: false });
        onTestFinished(() => clearAgentRunContext(runId));
      }
      const context = fixture.createContext({
        sessionKey: "agent:main:timeout-after-output",
        runId,
        cliSessionId: "stale-cli-session",
        openClawHistoryPrompt: fixture.historyPrompt,
      });
      context.params = {
        ...context.params,
        sourceReplyDeliveryMode: policy === "message_tool_only" ? "message_tool_only" : undefined,
        onBeforeFreshCliSessionRetry: clearBeforeRetry,
      };
      await expect(fixture.run(context)).rejects.toThrow("produced no output");
      expect(supervisorSpawnMock).toHaveBeenCalledTimes(1);
      expect(clearBeforeRetry).not.toHaveBeenCalled();
      // Fork (F38): no session event (it showed as "background command finished" and woke the
      // agent for an extra turn); the agent reads the notice at the start of its next turn.
      expect(enqueueSessionEventMock).not.toHaveBeenCalled();
      expect(enqueueSystemEventMock).toHaveBeenCalledTimes(1);
      expect(enqueueSystemEventMock).toHaveBeenCalledWith(
        expect.stringContaining("produced no output"),
        expect.objectContaining({
          sessionKey: "agent:main:timeout-after-output",
          contextKey: "cli_watchdog",
          replace: true,
        }),
      );
    },
  );
}
