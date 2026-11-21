// Fork: queued notification preference edits rebase onto the newest saved preferences.
// Kept out of web-push.runtime.ts so upstream changes there merge without conflicts.
function isPreferenceRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Re-applies one edit onto the newest saved preferences. The UI sends whole
 * objects built from what it rendered, so a queued edit would otherwise
 * overwrite fields that an earlier queued edit changed.
 */
export function rebasePreferenceEdit(base: unknown, edited: unknown, latest: unknown): unknown {
  if (!isPreferenceRecord(base) || !isPreferenceRecord(edited) || !isPreferenceRecord(latest)) {
    return edited;
  }
  const next: Record<string, unknown> = { ...latest };
  for (const key of new Set([...Object.keys(base), ...Object.keys(edited)])) {
    const before = base[key];
    const after = edited[key];
    if (isPreferenceRecord(before) && isPreferenceRecord(after)) {
      next[key] = rebasePreferenceEdit(before, after, latest[key]);
    } else if (JSON.stringify(before) !== JSON.stringify(after)) {
      if (after === undefined) {
        delete next[key];
      } else {
        next[key] = after;
      }
    }
  }
  return next;
}
