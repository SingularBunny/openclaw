import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { AcpRuntimeEvent } from "../../plugin-sdk/acp-runtime.js";
import {
  activeSessionOperations,
  hasReplyOperationExecutionStarted,
} from "../../sessions/session-controller.state.js";
import { createInternalHookEventPayload } from "../../test-utils/internal-hook-event-payload.js";
import { completeAcpSessionFixture } from "./dispatch-from-config.acp-fixture.test-support.js";
import {
  acpManagerRuntimeMocks,
  acpMocks,
  createDispatcher,
  hookMocks,
  internalHookMocks,
  mocks,
  mockSessionStorePath,
  noAbortResult,
  resetPluginTtsAndThreadMocks,
  sessionBindingMocks,
  sessionStoreMocks,
  setDiscordTestRegistry,
} from "./dispatch-from-config.shared.test-harness.js";
import { createAcpRuntime, createDispatchGate } from "./dispatch-from-config.test-support.js";
import { prepareReplySourceInput } from "./reply-source-binding.js";
import { buildTestCtx } from "./test-ctx.js";

let dispatchReplyFromConfig: typeof import("./dispatch-from-config.js").dispatchReplyFromConfig;
let tryDispatchAcpReplyHook: typeof import("../../plugin-sdk/acpx.js").tryDispatchAcpReplyHook;
let resetInboundDedupe: typeof import("./inbound-dedupe.js").resetInboundDedupe;
let controllerTesting: typeof import("../../sessions/session-controller.test-support.js").testing;
// Loaded after the harness mocks so the real manager reads the mocked ACP metadata.
let AcpSessionManager: typeof import("../../acp/control-plane/manager.core.js").AcpSessionManager;
let acpManagerDeps: typeof import("../../acp/control-plane/manager.types.js").DEFAULT_DEPS;

const acpKey = "agent:codex:acp:silent-turn";
const hooks = hookMocks.runner;
const store = sessionStoreMocks;
const cfg = {
  acp: { enabled: true, dispatch: { enabled: true } },
  session: { sendPolicy: { default: "allow" } },
} as OpenClawConfig;

function mockAcpSession(sessionKey: string) {
  const entry = { sessionId: "acp-session-id", updatedAt: Date.now() };
  sessionStoreMocks.entriesBySessionKey.set(sessionKey, entry);
  acpMocks.readAcpSessionEntry.mockImplementation((params: { sessionKey: string }) =>
    params.sessionKey === sessionKey
      ? completeAcpSessionFixture(
          { entry, acp: { agent: "codex" } },
          { sessionKey, storePath: mockSessionStorePath },
        )
      : null,
  );
}

async function dispatchTo(sessionKey: string, body: string) {
  const ctx = buildTestCtx({
    Provider: "discord",
    Surface: "discord",
    OriginatingChannel: "discord",
    AccountId: "default",
    To: "C1",
    SessionKey: sessionKey,
    BodyForAgent: body,
  });
  const source = await prepareReplySourceInput(ctx, cfg, {});
  return dispatchReplyFromConfig({
    ctx,
    cfg,
    dispatcher: createDispatcher(),
    replyOptions: source.options,
  });
}

describe("dispatchReplyFromConfig ACP turn liveness", () => {
  beforeAll(async () => {
    ({ dispatchReplyFromConfig } = await import("./dispatch-from-config.js"));
    ({ tryDispatchAcpReplyHook } = await import("../../plugin-sdk/acpx.js"));
    ({ resetInboundDedupe } = await import("./inbound-dedupe.js"));
    ({ testing: controllerTesting } =
      await import("../../sessions/session-controller.test-support.js"));
    ({ AcpSessionManager } = await import("../../acp/control-plane/manager.core.js"));
    ({ DEFAULT_DEPS: acpManagerDeps } = await import("../../acp/control-plane/manager.types.js"));
  });

  let manager: InstanceType<typeof AcpSessionManager>;

  beforeEach(() => {
    setDiscordTestRegistry();
    controllerTesting.resetSessionControllerForTest();
    resetInboundDedupe();
    resetPluginTtsAndThreadMocks();
    mocks.tryFastAbortFromMessage.mockResolvedValue(noAbortResult);
    for (const mock of [...Object.values(hooks), ...Object.values(acpMocks)]) {
      mock.mockReset();
    }
    manager = new AcpSessionManager({
      ...acpManagerDeps,
      prepareSessionControlRead: async (params) => {
        const readCurrent = async () => {
          params.assertCurrent?.();
          const session = completeAcpSessionFixture(acpMocks.readAcpSessionEntry(params), {
            ...params,
            storePath: sessionStoreMocks.resolveSessionStorePathCore(),
          });
          if (!session) {
            throw new Error(`Expected ACP session fixture: ${params.sessionKey}`);
          }
          return { session, entry: session.entry };
        };
        return {
          initialRead: await readCurrent(),
          readCurrent,
          assertCurrent: () => params.assertCurrent?.(),
          release: () => {},
        };
      },
    });
    acpManagerRuntimeMocks.getAcpSessionManager.mockReturnValue(manager);
    hooks.hasHooks.mockReset().mockImplementation((name?: string) => name === "reply_dispatch");
    hooks.runReplyDispatch.mockReset().mockImplementation(async (event: unknown, ctx: unknown) => {
      return (await tryDispatchAcpReplyHook(event as never, ctx as never)) ?? undefined;
    });
    internalHookMocks.createInternalHookEvent
      .mockReset()
      .mockImplementation(createInternalHookEventPayload);
    internalHookMocks.triggerInternalHook.mockReset();
    store.currentEntry = undefined;
    store.entriesBySessionKey.clear();
    const readSessionEntry = (scope: unknown) => {
      if (
        !scope ||
        typeof scope !== "object" ||
        !("sessionKey" in scope) ||
        typeof scope.sessionKey !== "string"
      ) {
        throw new Error("Expected session lookup scope");
      }
      return store.entriesBySessionKey.get(scope.sessionKey);
    };
    for (const load of [store.loadSessionEntry, store.loadSessionStoreEntry]) {
      load.mockReset().mockImplementation(readSessionEntry);
    }
    store.resolveSessionStorePathCore.mockReset().mockReturnValue(mockSessionStorePath);
    sessionBindingMocks.listBySession.mockReset().mockReturnValue([]);
    sessionBindingMocks.resolveByConversation.mockReset().mockReturnValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // A silent ACP turn (a long build) outlives the reply watchdog's abort window
  // (max(5 min, 3 x 2 min) = 6 min). Its own turn timeout bounds it, so neither the
  // chat's operation nor the operation the turn runs under on the ACP session may stop it.
  it.each(["bound", "direct"] as const)(
    "does not stop a silent %s ACP turn longer than the watchdog abort window",
    async (shape) => {
      vi.useFakeTimers({
        toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
        shouldAdvanceTime: true,
      });
      mockAcpSession(acpKey);
      const gate = createDispatchGate();
      let turnSignal: AbortSignal | undefined;
      const runtime = createAcpRuntime([]);
      runtime.runTurn.mockImplementation(async function* (input) {
        turnSignal = input.signal;
        await Promise.race([
          gate.wait(),
          new Promise<void>((resolve) => {
            input.signal?.addEventListener("abort", () => resolve(), { once: true });
          }),
        ]);
        yield { type: "text_delta", text: "build passed" } as AcpRuntimeEvent;
        yield { type: "done" } as AcpRuntimeEvent;
      });
      acpMocks.requireAcpRuntimeBackend.mockReturnValue({ id: "acpx", runtime });
      const chatKey = "agent:main:discord:channel:C1";
      if (shape === "bound") {
        sessionBindingMocks.resolveByConversation.mockReturnValue({
          bindingId: "binding-silent-turn",
          targetSessionKey: acpKey,
          targetKind: "session",
          status: "active",
          boundAt: Date.now(),
          conversation: { channel: "discord", accountId: "default", conversationId: "C1" },
        });
      }
      const work = dispatchTo(shape === "bound" ? chatKey : acpKey, "run the full build");
      await gate.started;
      const operations = [...activeSessionOperations()];
      expect(operations.map((operation) => operation.key).toSorted()).toEqual(
        shape === "bound" ? [acpKey, chatKey].toSorted() : [acpKey],
      );

      await vi.advanceTimersByTimeAsync(7 * 60_000);

      for (const operation of operations) {
        expect({ key: operation.key, decision: operation.watchdog.decide() }).toEqual({
          key: operation.key,
          decision: expect.objectContaining({ action: "observe", reason: "runtime_owned" }),
        });
        expect(operation.result).toBeNull();
      }
      expect(turnSignal?.aborted).toBe(false);
      gate.resolve();
      await work;
      expect(runtime.runTurn).toHaveBeenCalledTimes(1);
      for (const operation of operations) {
        expect(operation.result?.kind).toBe("completed");
      }
    },
  );

  // Fork: the session list shows a turn whose operation never started execution as "queued"
  // (a paused ring). A bound chat answered by an ACP agent stayed queued for the whole turn.
  it.each(["bound", "direct"] as const)(
    "marks the %s ACP turn's reply operations as executing while the agent works",
    async (shape) => {
      mockAcpSession(acpKey);
      const gate = createDispatchGate();
      const runtime = createAcpRuntime([]);
      runtime.runTurn.mockImplementation(async function* () {
        await gate.wait();
        yield { type: "text_delta", text: "done" } as AcpRuntimeEvent;
        yield { type: "done" } as AcpRuntimeEvent;
      });
      acpMocks.requireAcpRuntimeBackend.mockReturnValue({ id: "acpx", runtime });
      const chatKey = "agent:main:discord:channel:C1";
      if (shape === "bound") {
        sessionBindingMocks.resolveByConversation.mockReturnValue({
          bindingId: "binding-executing-turn",
          targetSessionKey: acpKey,
          targetKind: "session",
          status: "active",
          boundAt: Date.now(),
          conversation: { channel: "discord", accountId: "default", conversationId: "C1" },
        });
      }
      const work = dispatchTo(shape === "bound" ? chatKey : acpKey, "implement it");
      await gate.started;
      const operations = [...activeSessionOperations()];
      expect(operations.map((operation) => operation.key).toSorted()).toEqual(
        shape === "bound" ? [acpKey, chatKey].toSorted() : [acpKey],
      );
      expect(
        operations.map((operation) => [
          operation.key,
          hasReplyOperationExecutionStarted(operation),
        ]),
      ).toEqual(operations.map((operation) => [operation.key, true]));
      gate.resolve();
      await work;
    },
  );
});
