import path from "node:path";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import {
  hashCliSessionResumeCompat,
  readCliSessionResumePoint,
} from "../../config/sessions/cli-session-binding.js";
import { loadTranscriptEvents } from "../../config/sessions/session-accessor.js";
import { applyAssistantDeliveryDirectives } from "../../config/sessions/transcript-assistant-delivery.js";
import { sanitizeChatHistoryMessages } from "../../gateway/chat-display-projection.sanitize.js";
import type { AssistantMessage } from "../../llm/types.js";
import { upsertSessionEntry } from "../../plugin-sdk/session-store-runtime.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import type { PluginHookBeforeMessageWriteEvent } from "../../plugins/hook-types.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  onInternalSessionTranscriptUpdate,
  readSessionTranscriptRunId,
  type InternalSessionTranscriptUpdate,
} from "../../sessions/transcript-events.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { isIntermediateAssistantTranscriptMessage } from "../embedded-agent-runner/message-visibility.js";
import {
  persistCliAssistantTranscript,
  resolveCliTranscriptResumePoint,
} from "./cli-run-transcript.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-cli-coordination-transcript-");
afterEach(() => resetGlobalHookRunner());

it.each([
  { sourceTool: "sessions_send", hidden: true },
  { sourceTool: "subagent_announce", hidden: false },
])(
  "preserves CLI $sourceTool output with its display policy after hooks",
  async ({ sourceTool, hidden }) => {
    const root = sessionDirs.make();
    const target = {
      agentId: "main",
      sessionId: "cli-coordination-session",
      sessionKey: "agent:main:cli-coordination",
      storePath: path.join(root, "agents", "main", "agent", "openclaw-agent.sqlite"),
    };
    await upsertSessionEntry({
      ...target,
      entry: { sessionId: target.sessionId, updatedAt: Date.now() },
    });
    const registry = createEmptyPluginRegistry();
    registry.typedHooks.push({
      pluginId: "rewrite-output",
      hookName: "before_message_write",
      source: "test",
      handler: ({ message }: PluginHookBeforeMessageWriteEvent) => ({
        message: { ...message, display: true },
      }),
    });
    initializeGlobalHookRunner(registry);
    const updates: InternalSessionTranscriptUpdate[] = [];
    const unsubscribe = onInternalSessionTranscriptUpdate((update) => updates.push(update));
    try {
      const result = await persistCliAssistantTranscript({
        runParams: {
          ...target,
          config: {},
          sessionFile: `sqlite://agents/main/${target.sessionId}`,
          workspaceDir: root,
          prompt: "Review the worker result",
          provider: "claude-cli",
          runId: "cli-coordination-run",
          timeoutMs: 1_000,
          persistAssistantTranscript: true,
          inputProvenance: { kind: "inter_session", sourceTool, sourceRole: "subagent" },
        },
        text: "The worker result passed validation",
        modelId: "claude-sonnet-4-6",
        stopReason: "stop",
      });
      expect(result.owned).toBe(true);
      const messages = (await loadTranscriptEvents(target)).flatMap((event) =>
        typeof event === "object" && event !== null && "message" in event ? [event.message] : [],
      );
      expect(messages).toMatchObject([
        {
          role: "assistant",
          content: [{ type: "text", text: "The worker result passed validation" }],
        },
      ]);
      expect(Reflect.get(messages[0]!, "display") === false).toBe(hidden);
      expect(updates).toHaveLength(1);
      expect(Reflect.get(updates[0]!.message!, "display") === false).toBe(hidden);
      expect(readSessionTranscriptRunId(updates[0]!.message)).toBe("cli-coordination-run");
    } finally {
      unsubscribe();
    }
  },
);

it.each([
  { kind: "completed", yielded: undefined, stopReason: "stop" },
  { kind: "yielded", yielded: true, stopReason: "stop" },
  { kind: "interrupted after yielding", yielded: true, stopReason: "aborted" },
] as const)(
  "prepares the $kind CLI assistant before its first transcript publication",
  async ({ yielded, stopReason }) => {
    const root = sessionDirs.make();
    const target = {
      agentId: "main",
      sessionId: "cli-media-session",
      sessionKey: "agent:main:cli-media",
      storePath: path.join(root, "agents", "main", "agent", "openclaw-agent.sqlite"),
    };
    await upsertSessionEntry({
      ...target,
      entry: { sessionId: target.sessionId, updatedAt: Date.now() },
    });
    const sourceText = "Artifacts ready\nMEDIA:./artifact.json";
    const prepareAssistantTranscriptMessage = vi.fn((message: AssistantMessage) =>
      applyAssistantDeliveryDirectives(message, { managedMediaUrls: ["./artifact.json"] }),
    );
    const updates: InternalSessionTranscriptUpdate[] = [];
    const unsubscribe = onInternalSessionTranscriptUpdate((update) => updates.push(update));
    try {
      const result = await persistCliAssistantTranscript({
        runParams: {
          ...target,
          config: {},
          sessionFile: `sqlite://agents/main/${target.sessionId}`,
          workspaceDir: root,
          prompt: "make an artifact",
          provider: "claude-cli",
          runId: "cli-media-run",
          timeoutMs: 1_000,
          persistAssistantTranscript: true,
          prepareAssistantTranscriptMessage,
        },
        text: sourceText,
        modelId: "claude-sonnet-4-6",
        stopReason,
        yielded,
      });
      expect(result.owned).toBe(true);
      expect(result.idempotencyKey).toBe("cli-assistant:cli-media-run");
      expect(prepareAssistantTranscriptMessage).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ content: [{ type: "text", text: sourceText }] }),
        sourceText,
      );
      expect(updates).toHaveLength(1);
      expect(updates[0]?.message).toMatchObject({
        content: [{ type: "text", text: sourceText }],
        idempotencyKey: result.idempotencyKey,
        openclawDelivery: { mediaUrls: ["./artifact.json"] },
      });
      const messages = (await loadTranscriptEvents(target)).flatMap((event) =>
        typeof event === "object" && event !== null && "message" in event ? [event.message] : [],
      );
      expect(messages).toHaveLength(1);
      expect(isIntermediateAssistantTranscriptMessage(messages[0])).toBe(
        yielded === true && stopReason === "stop",
      );
      expect(messages[0]).toMatchObject({ stopReason });
      if (yielded && stopReason === "stop") {
        expect(messages[0]).toMatchObject({
          openclawStreamFallback: {
            replacementText: sourceText,
            source: "segment",
            itemId: "cli-media-run",
          },
        });
      } else {
        expect(messages[0]).not.toHaveProperty("openclawStreamFallback");
      }
      expect(sanitizeChatHistoryMessages(messages)).toMatchObject([
        { content: [{ type: "text", text: "Artifacts ready" }] },
      ]);
    } finally {
      unsubscribe();
    }
  },
);

it("records the native resume point beside the CLI assistant reply", async () => {
  const root = sessionDirs.make();
  const target = {
    agentId: "main",
    sessionId: "cli-resume-point-session",
    sessionKey: "agent:main:cli-resume-point",
    storePath: path.join(root, "agents", "main", "agent", "openclaw-agent.sqlite"),
  };
  await upsertSessionEntry({
    ...target,
    entry: { sessionId: target.sessionId, updatedAt: Date.now() },
  });
  const context = {
    params: { provider: "claude-cli" },
    effectiveAuthProfileId: "anthropic:work",
    authEpoch: "auth-epoch-a",
    authEpochVersion: 2,
    cwdHash: "cwd-a",
    preparedBackend: {
      backend: {
        command: "claude",
        forkArg: "--fork-session",
        resumeAtArg: "--resume-session-at",
      },
    },
  } as unknown as Parameters<typeof resolveCliTranscriptResumePoint>[0]["context"];
  const resumePoint = resolveCliTranscriptResumePoint({
    context,
    output: { resumeCheckpointId: "native-assistant-uuid" },
    cliSessionId: "native-session",
    bindingKept: true,
  });
  expect(resumePoint).toEqual({
    provider: "claude-cli",
    sessionId: "native-session",
    checkpointId: "native-assistant-uuid",
    // Same digest the settled binding produces, so later cuts can match it.
    compat: hashCliSessionResumeCompat({
      authProfileId: "anthropic:work",
      authEpoch: "auth-epoch-a",
      authEpochVersion: 2,
      cwdHash: "cwd-a",
    }),
  });

  await persistCliAssistantTranscript({
    runParams: {
      ...target,
      config: {},
      sessionFile: `sqlite://agents/main/${target.sessionId}`,
      workspaceDir: root,
      prompt: "hello",
      provider: "claude-cli",
      runId: "cli-resume-point-run",
      timeoutMs: 1_000,
      persistAssistantTranscript: true,
    },
    text: "hi",
    modelId: "claude-sonnet-4-6",
    stopReason: "stop",
    resumePoint,
  });
  const [message] = (await loadTranscriptEvents(target)).flatMap((event) =>
    typeof event === "object" && event !== null && "message" in event ? [event.message] : [],
  );
  expect(readCliSessionResumePoint(message)).toEqual(resumePoint);
  expect(readSessionTranscriptRunId(message)).toBe("cli-resume-point-run");
});

it.each([
  { name: "an unsaved binding", bindingKept: false },
  { name: "a missing checkpoint", output: { resumeCheckpointId: undefined } },
  { name: "an interrupted turn", output: { terminalInterruption: { reason: "timeout" } } },
  { name: "a yielded turn", output: { yielded: true } },
  { name: "a backend without fork-at-checkpoint", backend: { resumeAtArg: undefined } },
  { name: "a stateless backend", backend: { sessionMode: "none" } },
])("records no native resume point for $name", ({ bindingKept, output, backend }) => {
  expect(
    resolveCliTranscriptResumePoint({
      context: {
        params: { provider: "claude-cli" },
        authEpochVersion: 2,
        preparedBackend: {
          backend: {
            command: "claude",
            forkArg: "--fork-session",
            resumeAtArg: "--resume-session-at",
            ...backend,
          },
        },
      } as unknown as Parameters<typeof resolveCliTranscriptResumePoint>[0]["context"],
      output: { resumeCheckpointId: "checkpoint", ...output } as Parameters<
        typeof resolveCliTranscriptResumePoint
      >[0]["output"],
      cliSessionId: "native-session",
      bindingKept: bindingKept ?? true,
    }),
  ).toBeUndefined();
});
