import path from "node:path";
import type { AcpRuntimeEvent } from "@openclaw/acp-core/runtime/types";
import { afterAll, afterEach, describe, expect, test, vi } from "vitest";
import type { WebSocket } from "ws";
import type { dispatchInboundMessage } from "../auto-reply/dispatch.js";
import { createAcpSessionMeta } from "../auto-reply/reply/test-fixtures/acp-runtime.js";
import type { InternalSessionEntry } from "../config/sessions.js";
import { loadSessionEntryReadOnly } from "../config/sessions/session-accessor.js";
import { tryDispatchAcpReplyHook } from "../plugin-sdk/acpx.js";
import { getSessionWorkAdmissionRelease } from "../sessions/session-lifecycle-admission.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import {
  dispatchInboundMessageMock,
  installGatewayTestHooks,
  rpcReq,
  testState,
  writeSessionStore,
} from "./test-helpers.js";
import { installConnectedControlUiServerSuite } from "./test-with-server.js";

const runtime = vi.hoisted(() => ({ runTurn: vi.fn() }));

vi.mock("../auto-reply/reply/dispatch-acp-manager.runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../auto-reply/reply/dispatch-acp-manager.runtime.js")>()),
  getAcpSessionManager: () => ({
    resolveSessionAsync: async ({ sessionKey }: { sessionKey: string }) => ({
      kind: "ready",
      sessionKey,
      agentId: "main",
      meta: createAcpSessionMeta({ agent: "junie" }),
      entry: loadSessionEntryReadOnly({
        agentId: "main",
        sessionKey,
        storePath: testState.sessionStorePath,
      }),
    }),
    runTurn: runtime.runTurn,
    getObservabilitySnapshot: () => ({
      turns: { queueDepth: 0 },
      runtimeCache: { activeSessions: 1 },
    }),
  }),
  listSessionBindingsBySessionAsync: async () => [],
}));

installGatewayTestHooks({ scope: "suite" });
let ws: WebSocket;
installConnectedControlUiServerSuite((started) => {
  ws = started.ws;
});
const tempDirs = useSessionStoreTempDirs(afterAll, "openclaw-acp-bound-settlement-");

describe("Gateway chat bound to an ACP session", () => {
  afterEach(() => {
    dispatchInboundMessageMock.mockReset();
    runtime.runTurn.mockReset();
    testState.sessionStorePath = undefined;
  });

  test("a completed bound turn leaves no interrupted run for the chat's next turn", async () => {
    await runBoundTurn("completed");
  });

  test("a cancelled bound turn still records the interruption", async () => {
    const readChat = await runBoundTurn("cancelled");
    await vi.waitFor(() => {
      expect(readChat()).toMatchObject({ status: "killed", abortedLastRun: true });
    });
  });
});

async function runBoundTurn(outcome: "completed" | "cancelled") {
  const storePath = path.join(tempDirs.make(), "sessions.json");
  testState.sessionStorePath = storePath;
  // A dashboard chat answered by a bound ACP agent (`/acp spawn <agent> --bind here`).
  const chatKey = `agent:main:dashboard:bound-acp-chat-${outcome}`;
  const acpKey = `agent:main:acp:bound-acp-agent-${outcome}`;
  await writeSessionStore({
    entries: {
      [chatKey]: { sessionId: "chat-session", updatedAt: Date.now() },
      [acpKey]: {
        sessionId: "acp-session",
        updatedAt: Date.now(),
        acp: createAcpSessionMeta({ agent: "junie" }),
      },
    },
  });
  runtime.runTurn.mockImplementation(
    async ({ onEvent }: { onEvent: (event: AcpRuntimeEvent) => Promise<void> }) => {
      await onEvent({ type: "text_delta", text: "agent reply" });
      await onEvent({ type: "done", status: outcome });
    },
  );
  const admittedReleases: Array<Promise<void>> = [];
  const actualDispatch = await vi.importActual<typeof import("../auto-reply/dispatch.js")>(
    "../auto-reply/dispatch.js",
  );
  dispatchInboundMessageMock.mockImplementation(async (input: unknown) => {
    // SAFETY: The Gateway mock adapter forwards the real dispatchInboundMessage parameters.
    const { ctx, cfg, dispatcher, replyOptions } = input as Parameters<
      typeof dispatchInboundMessage
    >[0];
    const release = getSessionWorkAdmissionRelease({
      scope: storePath,
      identities: [ctx.SessionKey],
    });
    if (release) {
      admittedReleases.push(release);
    }
    return actualDispatch.dispatchInboundMessage({
      ctx,
      cfg,
      dispatcher,
      replyOptions,
      dispatchReplyFromConfig: async ({ ctx: finalized, replyOptions: options }) =>
        (await tryDispatchAcpReplyHook(
          {
            ctx: finalized,
            runId: options?.runId,
            sessionKey: acpKey,
            inboundAudio: false,
            shouldRouteToOriginating: false,
            shouldSendToolSummaries: false,
            shouldSendFullToolDetails: false,
            sendPolicy: "allow",
          },
          {
            ...options,
            cfg: { ...cfg, acp: { enabled: true, dispatch: { enabled: true } } },
            dispatcher,
            recordProcessed: () => {},
            markIdle: () => {},
          },
        )) ?? { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } },
    });
  });

  const runId = `bound-turn-${outcome}`;
  const boundRun = { sessionKey: chatKey, message: "question", idempotencyKey: runId };
  expect((await rpcReq(ws, "chat.send", boundRun)).ok).toBe(true);
  await vi.waitFor(
    async () => {
      expect((await rpcReq(ws, "chat.send", boundRun)).payload).toMatchObject({
        runId,
        status: outcome === "completed" ? "ok" : expect.stringMatching(/^(ok|error|timeout)$/),
      });
    },
    { timeout: 10_000 },
  );
  await Promise.all(admittedReleases);
  expect(runtime.runTurn).toHaveBeenCalledTimes(1);

  const readChat = () =>
    loadSessionEntryReadOnly({ agentId: "main", sessionKey: chatKey, storePath }) as
      | InternalSessionEntry
      | undefined;
  if (outcome === "cancelled") {
    return readChat;
  }
  // The bound turn's lifecycle end settles the chat row like any finished run.
  await vi.waitFor(() => {
    expect(readChat()).toMatchObject({ status: "done", lastRunId: runId });
  });
  expect(readChat()?.lifecycleRunId).toBeUndefined();
  expect(readChat()?.abortedLastRun).not.toBe(true);

  // Unbinding sends `/acp close` as the chat's next message. Its send reconciles any run
  // the chat still appears to own; a finished bound turn must not be marked interrupted.
  let seenByNextTurn: InternalSessionEntry | undefined;
  dispatchInboundMessageMock.mockImplementation(async () => {
    seenByNextTurn = readChat();
    return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
  });
  const closeRun = {
    sessionKey: chatKey,
    message: "/acp close",
    idempotencyKey: `close-turn-${outcome}`,
  };
  expect((await rpcReq(ws, "chat.send", closeRun)).ok).toBe(true);
  await vi.waitFor(() => expect(seenByNextTurn).toBeDefined());
  expect(seenByNextTurn?.abortedLastRun).not.toBe(true);
  expect(seenByNextTurn?.status).not.toBe("interrupted");
  expect(seenByNextTurn?.mainRestartRecovery).toBeUndefined();
  return readChat;
}
