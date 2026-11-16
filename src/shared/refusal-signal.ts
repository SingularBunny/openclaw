// Fork (I14): signs that a model declined a request, strongest first, for any model.
// 1. "provider": the API reported the refusal (`stop_reason: "refusal"` or a refusal content
//    part), recorded as a `provider_refusal` diagnostic or `__openclaw.refusal` on the row.
// 2. "marker": the model put REFUSAL_MARKER in its reply, as a rule in its instructions asks.
//    The marker is stripped before the reply is shown.
// 3. "phrase": a short reply that opens with a common way of declining. Weak: string matching
//    scores about F1 66-71 in published evaluations, so the hint for it is worded softer.
// Nothing here switches models; the Control UI only offers a hand-off button.
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";

export type RefusalSignal = "provider" | "marker" | "phrase";

/** What the gateway projects onto a refused assistant row (`__openclaw.refusal`). */
export type RefusalMetadata = { signal: RefusalSignal; category?: string };

/** The marker a model is asked to add when it declines; invisible as an HTML comment. */
export const REFUSAL_MARKER = "<!-- openclaw:refusal -->";

const REFUSAL_MARKER_RE = /<!--\s*openclaw:refusal\s*-->/iu;
const REFUSAL_MARKER_STRIP_RE = /[ \t]*<!--\s*openclaw:refusal\s*-->[ \t]*\n?/giu;

/**
 * Thresholds of the phrase signal, fixed before any evaluation: the reply is at most
 * 600 characters and a phrase starts within its first 200 characters. Long replies that
 * mention "I can't help with X" usually go on to help with the rest.
 */
export const REFUSAL_PHRASE_MAX_CHARS = 600;
export const REFUSAL_PHRASE_WINDOW_CHARS = 200;

// A small, conservative list in English and Russian. Cyrillic needs explicit letter
// boundaries: JavaScript's \b only knows ASCII word characters.
const REFUSAL_PHRASES: readonly RegExp[] = [
  /\bI(?: am|'m)? (?:can't|cannot|can not|won't|will not|not able to|unable to) (?:help|assist)(?: you)? with\b/iu,
  /\bI(?: am|'m) (?:not able|unable|not going|not willing) to (?:help|assist)\b/iu,
  /\bI (?:must|have to) (?:decline|refuse)\b/iu,
  /(?<!\p{L})не (?:могу|стану|буду) (?:помочь|помогать|содействовать|с этим помочь|в этом помочь)(?!\p{L})/iu,
  /(?<!\p{L})не могу выполнить (?:этот|эту|такой|такую|ваш|вашу) (?:запрос|просьбу)(?!\p{L})/iu,
  /(?<!\p{L})вынужден[аы]? отказать(?!\p{L})/iu,
];

const CATEGORY_RE = /^[a-z0-9_-]{1,64}$/iu;

function readCategory(value: unknown): string | undefined {
  return typeof value === "string" && CATEGORY_RE.test(value) ? value : undefined;
}

export function hasRefusalMarker(text: string): boolean {
  return REFUSAL_MARKER_RE.test(text);
}

export function stripRefusalMarker(text: string): string {
  return REFUSAL_MARKER_RE.test(text) ? text.replace(REFUSAL_MARKER_STRIP_RE, "") : text;
}

/** The phrase signal: a short reply that opens by declining (thresholds above). */
export function matchesRefusalPhrase(text: string): boolean {
  const trimmed = text.replaceAll("’", "'").trim();
  if (!trimmed || trimmed.length > REFUSAL_PHRASE_MAX_CHARS) {
    return false;
  }
  const opening = trimmed.slice(0, REFUSAL_PHRASE_WINDOW_CHARS + 60);
  return REFUSAL_PHRASES.some((phrase) => {
    const match = phrase.exec(opening);
    return match !== null && match.index < REFUSAL_PHRASE_WINDOW_CHARS;
  });
}

/** Text blocks of a message (string content or `{ type: "text" }` blocks). */
export function readMessageTextBlocks(message: unknown): string[] {
  const content = asOptionalRecord(message)?.content;
  if (typeof content === "string") {
    return [content];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  return content.flatMap((block) => {
    const entry = asOptionalRecord(block);
    return entry?.type === "text" && typeof entry.text === "string" ? [entry.text] : [];
  });
}

/** The API signal recorded on a stored assistant row by any provider adapter. */
export function readProviderRefusal(message: unknown): RefusalMetadata | undefined {
  const record = asOptionalRecord(message);
  if (!record || record.role !== "assistant") {
    return undefined;
  }
  const recorded = asOptionalRecord(asOptionalRecord(record["__openclaw"])?.refusal);
  if (recorded?.signal === "provider") {
    const category = readCategory(recorded.category);
    return { signal: "provider", ...(category ? { category } : {}) };
  }
  const diagnostic = Array.isArray(record.diagnostics)
    ? record.diagnostics.find((entry) => asOptionalRecord(entry)?.type === "provider_refusal")
    : undefined;
  if (diagnostic) {
    const category = readCategory(
      asOptionalRecord(asOptionalRecord(diagnostic)?.details)?.category,
    );
    return { signal: "provider", ...(category ? { category } : {}) };
  }
  // Older transcripts keep only the provider's safety stop code.
  return record.errorCode === "misalignment_policy_violation"
    ? { signal: "provider", category: "misalignment" }
    : undefined;
}

/** The strong signals of a stored row: the API's, else the model's own marker. */
export function readStoredRefusal(message: unknown): RefusalMetadata | undefined {
  const provider = readProviderRefusal(message);
  if (provider) {
    return provider;
  }
  const record = asOptionalRecord(message);
  if (record?.role !== "assistant") {
    return undefined;
  }
  const recorded = asOptionalRecord(asOptionalRecord(record["__openclaw"])?.refusal);
  if (recorded?.signal === "marker") {
    return { signal: "marker" };
  }
  return readMessageTextBlocks(record).some(hasRefusalMarker) ? { signal: "marker" } : undefined;
}

/** Set once the user handed the refused turn off; the turn is then out of the model context. */
export function readRefusalHandoff(message: unknown): boolean {
  return Boolean(asOptionalRecord(asOptionalRecord(message)?.["__openclaw"])?.refusalHandoff);
}
