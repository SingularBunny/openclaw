// Fork: native CLI continuity across message cuts (rewind, edit, branch switch, message fork).
// Kept out of session-message-cut-plan.ts so upstream changes there merge without conflicts.
import { asOptionalRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { readCliSessionResumePoint } from "./cli-session-binding-fork.js";
import type { TranscriptEvent } from "./session-accessor.sqlite-contract.js";
import {
  scanSessionTranscriptTree,
  selectSessionTranscriptTreePathNodes,
} from "./transcript-tree.js";
import type { CliSessionBinding } from "./types.js";

/** The `cliSessionIds` mirror of resumed bindings (provider to native session id). */
export function cliSessionIdsOf(
  bindings: Record<string, CliSessionBinding> | undefined,
): Record<string, string> | undefined {
  return bindings
    ? Object.fromEntries(
        Object.entries(bindings).map(([provider, binding]) => [provider, binding.sessionId]),
      )
    : undefined;
}

/** The native checkpoint of the last assistant turn on the branch ending at `leafId`. */
export function readCliResumePointAtLeaf(
  events: readonly TranscriptEvent[],
  hydrate: ((selected: readonly TranscriptEvent[]) => Iterable<TranscriptEvent>) | undefined,
  leafId: string | null,
) {
  if (!leafId) {
    return undefined;
  }
  const tree = scanSessionTranscriptTree(events);
  const lastAssistant = selectSessionTranscriptTreePathNodes(tree, leafId).findLast((node) => {
    const record = asRecord(node.entry);
    return record?.type === "message" && asRecord(record.message)?.role === "assistant";
  });
  if (!lastAssistant) {
    return undefined;
  }
  const point = readCliSessionResumePoint(asRecord(lastAssistant.entry)?.message);
  if (point || !hydrate) {
    return point;
  }
  const [full] = hydrate([lastAssistant.entry as TranscriptEvent]);
  return readCliSessionResumePoint(asRecord(full)?.message);
}

/** Copies a path's entries with their tree parent ids, for the native-only cut's prefix. */
export function copyPathPrefix(
  nodes: ReturnType<typeof selectSessionTranscriptTreePathNodes>,
): TranscriptEvent[] {
  return nodes.map((node) => {
    const entry = asRecord(node.entry);
    // Spread (not Object.assign) so a parsed own `__proto__` key stays an inert
    // data property instead of rebinding the copy's prototype.
    return entry && entry.parentId !== node.parentId
      ? { ...entry, parentId: node.parentId }
      : node.entry;
  });
}
