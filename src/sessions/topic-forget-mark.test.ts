import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { loadCliSessionEntries } from "../agents/cli-runner/session-history.js";
import { appendTranscriptMessage } from "../config/sessions/session-accessor.js";
import { loadTranscriptEventRowsAfterSeqSync } from "../config/sessions/session-accessor.sqlite-read.js";
import { SYNC_REBUILD_MAX_ROWS } from "../config/sessions/session-transcript-index.js";
import { upsertSessionEntry } from "../plugin-sdk/session-store-runtime.js";
import { withTempHome } from "../plugin-sdk/test-env.js";
import {
  collectForgetTurns,
  findForgetCandidates,
  markEntriesForgotten,
  type ForgetTarget,
} from "./topic-forget-fork.js";

async function transcriptWithTurns(home: string, turns: number): Promise<ForgetTarget> {
  const target = {
    agentId: "main",
    sessionId: "forget-session",
    sessionKey: "agent:main:forget",
    storePath: path.join(fs.realpathSync(home), ".openclaw", "forget", "sessions.json"),
  };
  await upsertSessionEntry({ ...target, entry: { sessionId: target.sessionId, updatedAt: 1 } });
  for (let turn = 0; turn < turns; turn += 1) {
    await appendTranscriptMessage(target, {
      message: { role: "user", content: `question ${turn} about antibot`, timestamp: turn * 2 },
    });
    await appendTranscriptMessage(target, {
      message: {
        role: "assistant",
        content: [{ type: "text", text: `answer ${turn} about antibot` }],
        timestamp: turn * 2 + 1,
      },
    });
  }
  return target;
}

const tickedIds = async (target: ForgetTarget) =>
  collectForgetTurns(await loadCliSessionEntries({ sessionTarget: target })).flatMap(
    (turn) => turn.entryIds,
  );

it("marks every ticked entry of a real transcript", async () => {
  await withTempHome(async (home) => {
    const target = await transcriptWithTurns(home, 6);
    const entryIds = await tickedIds(target);
    expect(entryIds).toHaveLength(12);

    const changed = await markEntriesForgotten({ target, entryIds, topic: "antibot" });

    expect(changed.toSorted()).toEqual(entryIds.toSorted());
    // Forgotten rows never reach a model context again, so a second search finds nothing.
    expect(await tickedIds(target)).toEqual([]);
  });
});

// Live 23.11.2026: after 15 turns were forgotten, searching the same topic again ticked 12 new ones,
// because the chat history the search reads has no forgotten rows and the baseline dropped.
it("a repeated search after forgetting ticks no new turns", async () => {
  await withTempHome(async (home) => {
    const target = await transcriptWithTurns(home, 0);
    const texts = [
      "bots one",
      "bots two",
      ...Array.from({ length: 7 }, (_, i) => `weather ${i}`),
      "weather near",
    ];
    for (const [index, text] of texts.entries()) {
      await appendTranscriptMessage(target, {
        message: { role: "user", content: text, timestamp: index },
      });
    }
    // Cosine with the topic: 1 for the two bot turns, 0.447 for "weather near", 0 for the rest.
    const vector = (text: string) =>
      text.startsWith("bots") ? [1, 0] : text === "weather near" ? [0.5, 1] : [0, 1];
    const embedder = {
      embedQuery: async () => [1, 0],
      embedDocuments: async (batch: string[]) => batch.map(vector),
    };
    const ticked = async () =>
      (await findForgetCandidates({ target, topic: "spam", embedder }))
        .filter((candidate) => candidate.selected)
        .map((candidate) => candidate.preview);

    const first = await findForgetCandidates({ target, topic: "spam", embedder });
    expect(await ticked()).toEqual(["bots one", "bots two"]);
    const entryIds = first.filter((c) => c.selected).flatMap((c) => c.entryIds);
    await markEntriesForgotten({ target, entryIds, topic: "spam" });

    // Without the forgotten turns "weather near" alone would be above mean + deviation.
    expect(await ticked()).toEqual([]);
  });
});

// Live 23.11.2026, a copy of a 5105-row chat: 4 of 567 ticked entries were marked in 14 minutes.
// Above 4000 rows the Gateway rebuilds the projection in the background after a rewrite, and rows
// looked up through it one by one were missing; one correction marks them all.
it("marks every ticked entry of a transcript above the synchronous rebuild limit", async () => {
  await withTempHome(async (home) => {
    const turns = Math.ceil(SYNC_REBUILD_MAX_ROWS / 2) + 50;
    const target = await transcriptWithTurns(home, turns);
    const all = await tickedIds(target);
    expect(all.length).toBeGreaterThan(SYNC_REBUILD_MAX_ROWS);
    const entryIds = all.filter((_, index) => index % 37 === 0);

    const started = Date.now();
    const changed = await markEntriesForgotten({ target, entryIds, topic: "antibot" });

    expect(changed.toSorted()).toEqual(entryIds.toSorted());
    expect(Date.now() - started).toBeLessThan(30_000);
    // Checked on the stored rows: the projection rebuild needs the Gateway's main thread, and
    // test workers are not one.
    const forgotten = loadTranscriptEventRowsAfterSeqSync(target, -1).flatMap(({ event }) => {
      const row = event as { id?: string; message?: { excludeFromContext?: boolean } };
      return row.message?.excludeFromContext === true && row.id ? [row.id] : [];
    });
    expect(forgotten.toSorted()).toEqual(entryIds.toSorted());
  });
}, 300_000);
