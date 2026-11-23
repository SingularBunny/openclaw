// Fork: marks transcript message rows in one correction. Rewriting rows one by one through
// their anchors loses rows on large chats: above the synchronous limit (4000 rows) each rewrite
// leaves the projection to a background rebuild, anchors read as missing until it runs, and a
// rebuild scheduled from a worker thread fails ("Agent admission requires its host owner").
// Live 23.11.2026: Forget a topic marked 4 of 567 rows that way.
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  resolveSqliteTranscriptReadScope,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import { withPreparedTranscriptCorrection } from "../config/sessions/session-transcript-correction.js";
import { reconcileSessionTranscriptIndexes } from "../config/sessions/session-transcript-reconcile.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("sessions/row-mark");

export type TranscriptRowTarget = {
  agentId: string;
  sessionId: string;
  sessionKey: string;
  storePath: string;
};

/**
 * Applies `mark` to the message of every row in `entryIds` in one transcript write and returns the
 * ids it changed. `mark` returns the new message, or undefined to leave the row as it is.
 */
export async function markTranscriptRows(params: {
  target: TranscriptRowTarget;
  entryIds: readonly string[];
  mark: (message: Record<string, unknown>) => Record<string, unknown> | undefined;
}): Promise<string[]> {
  const wanted = new Set(params.entryIds);
  if (wanted.size === 0) {
    return [];
  }
  const changed = await withPreparedTranscriptCorrection(params.target, async (transcript) => {
    const events = await transcript.readEvents();
    const marked: string[] = [];
    const replaced = events.map((event) => {
      const row = asOptionalRecord(event);
      const message = asOptionalRecord(row?.message);
      if (
        row?.type !== "message" ||
        typeof row.id !== "string" ||
        !wanted.has(row.id) ||
        !message
      ) {
        return event;
      }
      // A copy, not an in-place edit: readEvents may hand out cached rows.
      const updated = params.mark(Object.assign({}, message));
      if (!updated) {
        return event;
      }
      marked.push(row.id);
      return Object.assign({}, row, { message: updated }) as typeof event;
    });
    if (marked.length > 0) {
      await transcript.replaceEvents(replaced);
    }
    return marked;
  });
  if (changed.length > 0) {
    // Run the projection rebuild here, on the Gateway's main thread (see above).
    const database = toDatabaseOptions(resolveSqliteTranscriptReadScope(params.target));
    try {
      await reconcileSessionTranscriptIndexes({
        ...database,
        preferredSessionId: params.target.sessionId,
      });
    } catch (error) {
      log.warn(
        `transcript projection rebuild deferred: session=${params.target.sessionKey}: ${String(error)}`,
      );
    }
  }
  return changed;
}
