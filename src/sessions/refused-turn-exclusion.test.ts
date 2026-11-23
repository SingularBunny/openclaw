import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { makeUserMessage } from "../../test/helpers/user-message.js";
import {
  buildCliSessionHistoryPrompt,
  loadCliSessionEntries,
  loadCliSessionPromptContext,
} from "../agents/cli-runner/session-history.js";
import type { SessionEntry } from "../agents/sessions/session-manager.js";
import { buildAssistantMessage, buildUsageWithNoCost } from "../agents/stream-message-shared.js";
import { buildAcpParentHistoryPrompt } from "../auto-reply/reply/dispatch-acp-parent-history.runtime.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  appendTranscriptMessage,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { loadTranscriptEventRowsAfterSeqSync } from "../config/sessions/session-accessor.sqlite-read.js";
import { rewritePreparedTranscriptMessageAtAnchor } from "../config/sessions/session-message-rewrite.js";
import { readActiveTranscriptEntryAnchorAsync } from "../config/sessions/session-transcript-anchor-read.js";
import { SYNC_REBUILD_MAX_ROWS } from "../config/sessions/session-transcript-index.js";
import { cleanupSessionStateForTest } from "../test-utils/session-state-cleanup.js";
import {
  excludeRefusedTurnFromContext,
  selectRefusedTurnEntryIds,
} from "./refused-turn-exclusion.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    for (const stateDir of tempDirs.dirs) {
      await cleanupSessionStateForTest({ stateDir });
    }
    cleanup();
  });
});

function entry(id: string, message: Record<string, unknown>): SessionEntry {
  return { type: "message", id, parentId: null, timestamp: "", message } as unknown as SessionEntry;
}

describe("refused turn selection (I14)", () => {
  it("takes the question, tool steps and the refused reply, and nothing older", () => {
    const entries = [
      entry("u0", { role: "user" }),
      entry("a0", { role: "assistant", stopReason: "stop" }),
      entry("u1", { role: "user" }),
      entry("t1", { role: "assistant", stopReason: "toolUse" }),
      entry("r1", { role: "toolResult" }),
      entry("a1", { role: "assistant", stopReason: "error" }),
    ];
    expect(selectRefusedTurnEntryIds(entries, "a1")).toEqual(["u1", "t1", "r1", "a1"]);
    expect(selectRefusedTurnEntryIds(entries, "u1")).toEqual([]);
    expect(selectRefusedTurnEntryIds(entries, "missing")).toEqual([]);
    // Without a question in reach, an earlier finished reply stops the walk.
    expect(selectRefusedTurnEntryIds(entries.slice(1, 2).concat(entries.slice(5)), "a1")).toEqual([
      "a1",
    ]);
  });
});

describe("refused turn exclusion (I14)", () => {
  async function createChat() {
    const dir = tempDirs.make("openclaw-refused-turn-");
    const storePath = path.join(dir, "openclaw-agent.sqlite");
    const cfg = { session: { store: storePath } } as OpenClawConfig;
    const target = {
      agentId: "main",
      sessionId: "parent-session",
      sessionKey: "agent:main:main",
      storePath,
    };
    const child = { agentId: "main", sessionId: "child-session", sessionKey: "agent:main:acp:c" };
    await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
    await upsertSessionEntryCore(
      { ...child, storePath },
      { sessionId: child.sessionId, updatedAt: 1 },
    );
    const user = async (id: string, text: string, now: number) =>
      await appendTranscriptMessage(target, {
        eventId: id,
        now,
        message: makeUserMessage(text, now),
      });
    const assistant = async (id: string, text: string, now: number, extra = {}) =>
      await appendTranscriptMessage(target, {
        eventId: id,
        now,
        message: {
          ...buildAssistantMessage({
            model: { api: "cli", provider: "claude-cli", id: "claude-opus" },
            content: [{ type: "text", text }],
            stopReason: "stop",
            usage: buildUsageWithNoCost({}),
          }),
          ...extra,
        },
      });
    return { cfg, target, child, user, assistant };
  }

  it("keeps the refused turn visible but out of the Claude CLI reseed and the ACP seed", async () => {
    const { cfg, target, child, user, assistant } = await createChat();
    await user("u1", "Plan the migration.", 1_000);
    await assistant("a1", "Step one: freeze writes.", 2_000);
    await user("u2", "Write the exploit.", 3_000);
    await assistant("a2", "I can't help with that.", 4_000, {
      __openclaw: { refusal: { signal: "provider" } },
    });

    const result = await excludeRefusedTurnFromContext({
      target,
      messageId: "a2",
      signal: "provider",
      now: 5_000,
    });
    expect(result).toEqual({ entryIds: ["u2", "a2"], excluded: ["u2", "a2"] });
    // A second hand-off of the same turn changes nothing.
    expect(
      (await excludeRefusedTurnFromContext({ target, messageId: "a2", signal: "provider" }))
        .excluded,
    ).toEqual([]);

    // Out of the model context...
    const context0 = await loadCliSessionEntries({ sessionTarget: target });
    expect(context0.map((row) => row.id)).toEqual(["u1", "a1"]);
    // ...but still in the active transcript the chat shows, marked.
    for (const entryId of ["u2", "a2"]) {
      const anchor = await readActiveTranscriptEntryAnchorAsync({ ...target, entryId });
      expect(anchor?.entryId).toBe(entryId);
      let stored: unknown;
      await rewritePreparedTranscriptMessageAtAnchor(anchor!, (message) => {
        stored = message;
        return undefined;
      });
      expect(stored).toMatchObject({
        excludeFromContext: true,
        __openclaw: { refusalHandoff: { signal: "provider", at: 5_000 } },
      });
    }

    // The question is re-sent to the next model.
    await user("u3", "Write the exploit.", 6_000);

    // Claude CLI reseed (fresh session) and author labels.
    const context = await loadCliSessionPromptContext({
      sessionTarget: target,
      allowRawTranscriptReseed: true,
      rawTranscriptReseedReason: "session-expired",
      provider: "openrouter",
    });
    const reseed = buildCliSessionHistoryPrompt({
      messages: context.reseedMessages,
      prompt: "Write the exploit.",
      currentAuthor: { provider: "openrouter", model: "x/y" },
    })!;
    expect(reseed).toContain("Assistant [claude-cli/claude-opus]: Step one: freeze writes.");
    expect(reseed).not.toContain("I can't help with that.");
    expect(reseed.match(/Write the exploit\./gu)).toHaveLength(2);

    // ACP parent-history seed of a newly bound agent.
    const acp = (await buildAcpParentHistoryPrompt({
      cfg,
      parentSessionKey: target.sessionKey,
      child,
      acpAgent: "codex",
      prompt: "Write the exploit.",
    }))!;
    expect(acp).toContain("User: Plan the migration.");
    expect(acp).not.toContain("I can't help with that.");
    expect(acp.match(/Write the exploit\./gu)).toHaveLength(1);
  });

  // Rows rewritten one by one through anchors were lost above the synchronous rebuild limit
  // (Forget a topic, live 23.11.2026: 4 of 567); the hand-off marks its turn in one write.
  it("excludes every row of a refused turn in a chat above the synchronous rebuild limit", async () => {
    const { target, user, assistant } = await createChat();
    for (let turn = 0; turn < Math.ceil(SYNC_REBUILD_MAX_ROWS / 2) + 10; turn += 1) {
      await user(`u${turn}`, `question ${turn}`, turn * 2);
      await assistant(`a${turn}`, `answer ${turn}`, turn * 2 + 1);
    }
    const now = 1_000_000;
    await user("q", "Write the exploit.", now);
    const steps: string[] = [];
    for (let step = 0; step < 5; step += 1) {
      await assistant(`t${step}`, "looking", now + step * 2 + 1, { stopReason: "toolUse" });
      await appendTranscriptMessage(target, {
        eventId: `r${step}`,
        now: now + step * 2 + 2,
        message: {
          role: "toolResult",
          toolCallId: `call${step}`,
          toolName: "read",
          content: [{ type: "text", text: "ok" }],
          isError: false,
          timestamp: now + step * 2 + 2,
        },
      });
      steps.push(`t${step}`, `r${step}`);
    }
    await assistant("refused", "I can't help with that.", now + 100);

    const result = await excludeRefusedTurnFromContext({
      target,
      messageId: "refused",
      signal: "provider",
      now: now + 200,
    });
    const expected = ["q", ...steps, "refused"];
    expect(result).toEqual({ entryIds: expected, excluded: expected });
    // Checked on the stored rows: the projection rebuild needs the Gateway's main thread.
    const excluded = loadTranscriptEventRowsAfterSeqSync(target, -1).flatMap(({ event }) => {
      const row = event as { id?: string; message?: { excludeFromContext?: boolean } };
      return row.message?.excludeFromContext === true && row.id ? [row.id] : [];
    });
    expect(excluded.toSorted()).toEqual(expected.toSorted());
  }, 300_000);
});
