/** Tests that a Claude turn's canonical transcript row joins the native history once. */
import path from "node:path";
import { afterAll, expect, it, vi } from "vitest";
import { loadTranscriptEvents } from "../config/sessions/session-accessor.js";
import { MemoryCliSessionHistoryIndex } from "../gateway/cli-session-history-index-memory.js";
import { upsertSessionEntry } from "../plugin-sdk/session-store-runtime.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import type { CliOutput } from "./cli-output-contracts.js";
import { transformCliResultText } from "./cli-output-results.js";
import { runPreparedCliAgent } from "./cli-runner.js";
import { buildPreparedCliRunContext } from "./cli-runner.test-helpers.js";

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
// mock-isolation: supply parsed output without spawning a backend.
vi.mock("./cli-runner/execute.runtime.js", () => ({ executePreparedCliRun: execute }));
const dirs = useSessionStoreTempDirs(afterAll, "cli-history-owner-");

const NARRATION = ["Checking now", "Checking inputs"] as const;

it.each([
  { transformed: false, interrupted: false, yielded: false, single: false },
  { transformed: true, interrupted: false, yielded: false, single: false },
  { transformed: false, interrupted: true, yielded: false, single: false },
  { transformed: false, interrupted: false, yielded: true, single: false },
  { transformed: false, interrupted: false, yielded: false, single: true },
])("settles Claude history safely: %j", async ({ transformed, interrupted, yielded, single }) => {
  const root = dirs.make();
  const target = {
    agentId: "main",
    sessionId: "ownership",
    sessionKey: "agent:main:ownership",
    storePath: path.join(root, "agents/main/agent/openclaw-agent.sqlite"),
  };
  await upsertSessionEntry({
    ...target,
    entry: { sessionId: target.sessionId, updatedAt: Date.now() },
  });
  const replacements = [{ from: "Done", to: "Finished" }];
  const parsed: CliOutput = {
    text: single ? "Done" : [...NARRATION, "Done"].join("\n"),
    ...(single ? {} : { rawFinalText: "Done" }),
    sessionId: "native-session",
    resumeCheckpointId: "final-uuid",
    ...(interrupted ? { terminalInterruption: { reason: "aborted" as const } } : {}),
    ...(yielded ? { yielded: true as const } : {}),
  };
  // The process layer applies output replacements before the runner sees the result.
  execute.mockResolvedValue(transformed ? transformCliResultText(parsed, replacements) : parsed);
  const context = buildPreparedCliRunContext({
    sessionTarget: target,
    workspaceDir: root,
    runId: "owner-run",
  });
  Object.assign(context.params, {
    config: {},
    storePath: target.storePath,
    persistAssistantTranscript: true,
    provider: "claude-cli",
  });
  if (transformed) {
    context.backendResolved.textTransforms = { output: replacements };
  }
  await runPreparedCliAgent(context);
  const local = (await loadTranscriptEvents(target)).flatMap((event) =>
    typeof event === "object" && event !== null && "message" in event ? [event.message] : [],
  );
  expect(local).toHaveLength(1);
  if (interrupted || yielded) {
    expect(local[0]).toMatchObject({
      content: [{ type: "text", text: parsed.text }],
    });
    expect(local[0]).not.toHaveProperty("__openclaw.externalId");
    return;
  }
  // Narration stays in Claude's native rows; the canonical row is the final message.
  expect(local[0]).toMatchObject({
    content: [{ type: "text", text: transformed ? "Finished" : "Done" }],
    __openclaw: {
      importedFrom: "claude-cli",
      cliSessionId: "native-session",
      externalId: "final-uuid",
    },
  });
  const index = new MemoryCliSessionHistoryIndex();
  index.appendLocal(local.map((message, i) => ({ message, seq: i + 1 })));
  // Claude wrote these native rows while the turn ran, before the canonical final committed.
  const startedAt = Date.now() - 10_000;
  const nativeRows = [
    ...(single ? [] : NARRATION.map((text, i) => [`progress-uuid-${i}`, text] as const)),
    ["final-uuid", "Done"] as const,
  ];
  for (const [offset, [uuid, text]] of nativeRows.entries()) {
    index.appendImported({
      role: "assistant",
      content: [{ type: "text", text }],
      timestamp: startedAt + offset * 1000,
      __openclaw: {
        importedFrom: "claude-cli",
        cliSessionId: "native-session",
        externalId: uuid,
      },
    });
  }
  index.finish();
  // Each narration and the final answer appear once; the final is the canonical row.
  expect(index.count).toBe(nativeRows.length);
  expect(index.rows(0, nativeRows.length).map((row) => row.local_seq)).toEqual([
    ...nativeRows.slice(0, -1).map(() => null),
    1,
  ]);
  index.close();
});
