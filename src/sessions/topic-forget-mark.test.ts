import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { loadCliSessionEntries } from "../agents/cli-runner/session-history.js";
import { appendTranscriptMessage } from "../config/sessions/session-accessor.js";
import { readActiveTranscriptEntryAnchorAsync } from "../config/sessions/session-transcript-anchor-read.js";
import { upsertSessionEntry } from "../plugin-sdk/session-store-runtime.js";
import { withTempHome } from "../plugin-sdk/test-env.js";
import {
  collectForgetTurns,
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

// Live 23.11.2026: 56 entries were ticked and one was marked ("forgotten=1/56"): after each rewrite
// the Gateway rebuilds the transcript projection, and an entry read during the rebuild is missing.
it("waits out a projection rebuild instead of skipping the entries read during it", async () => {
  await withTempHome(async (home) => {
    const target = await transcriptWithTurns(home, 3);
    const entryIds = await tickedIds(target);
    let rebuilding = false;
    let waits = 0;
    const changed = await markEntriesForgotten({
      target,
      entryIds,
      topic: "antibot",
      deps: {
        // Every successful read is followed by a rebuild; reads during it find nothing, as live.
        readAnchor: async (scope, signal) => {
          if (rebuilding) {
            return undefined;
          }
          rebuilding = true;
          return await readActiveTranscriptEntryAnchorAsync(scope, signal);
        },
        waitForProjection: async () => {
          waits += 1;
          if (waits % 2 === 0) {
            rebuilding = false;
          }
        },
        sleep: async () => {},
      },
    });
    expect(changed.toSorted()).toEqual(entryIds.toSorted());
    expect(await tickedIds(target)).toEqual([]);
  });
});
