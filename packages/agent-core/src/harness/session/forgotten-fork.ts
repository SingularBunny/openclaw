// Fork (N11): topics the user asked the agent to forget. Forgotten messages carry
// `excludeFromContext` and `__openclaw.forgotten`; unlike other excluded rows they never come
// back, not even through a reset's retained tail. A compaction summary written over forgotten
// messages may retell them, so it is replaced by a neutral note instead of being sent.
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { SessionTreeEntry } from "../types.js";

export const FORGOTTEN_SUMMARY =
  "The summary of the earlier conversation was removed: the user asked to forget part of it.";

/** A message the user asked to forget (`__openclaw.forgotten`). */
export function isForgottenEntry(entry: SessionTreeEntry): boolean {
  if (entry.type !== "message") {
    return false;
  }
  const message = asOptionalRecord(entry.message);
  return asOptionalRecord(message?.["__openclaw"])?.forgotten !== undefined;
}

const neutralizedBoundaries = new WeakSet<object>();

/** Marks the context boundary when a message before it was forgotten. */
export function markForgottenBoundary(
  pathEntries: readonly SessionTreeEntry[],
  boundaryIndex: number,
): void {
  const boundary = pathEntries[boundaryIndex];
  if (
    boundary?.type === "compaction" &&
    pathEntries.slice(0, boundaryIndex).some((entry) => isForgottenEntry(entry))
  ) {
    neutralizedBoundaries.add(boundary);
  }
}

/** Whether this selected boundary's summary must not reach the model. */
export function isNeutralizedBoundary(entry: object): boolean {
  return neutralizedBoundaries.has(entry);
}

/** Fork (N11): a summary written over forgotten messages is not carried into the next one. */
export function forgottenPreviousSummary(
  pathEntries: readonly SessionTreeEntry[],
  boundaryIndex: number,
  previousSummary: string | undefined,
): string | undefined {
  return previousSummary !== undefined &&
    pathEntries.slice(0, boundaryIndex).some((entry) => isForgottenEntry(entry))
    ? FORGOTTEN_SUMMARY
    : previousSummary;
}
