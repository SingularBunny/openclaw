/**
 * Fork (F72): newest turns first, up to `maxTurns` (default `defaultMaxTurns`), and with
 * `maxChars` only while their JSON fits that budget (the newest turn always fits;
 * per-field truncation bounds it).
 */
export function selectNewestUnseenTurns<T>(
  turns: T[],
  defaultMaxTurns: number,
  limits?: { maxTurns: number; maxChars?: number },
): T[] {
  const capped = turns.slice(-(limits?.maxTurns ?? defaultMaxTurns));
  if (limits?.maxChars === undefined) {
    return capped;
  }
  let chars = 0;
  let start = capped.length;
  while (start > 0) {
    const next = JSON.stringify(capped[start - 1]).length + 1;
    if (start < capped.length && chars + next > limits.maxChars) {
      break;
    }
    chars += next;
    start -= 1;
  }
  return capped.slice(start);
}
