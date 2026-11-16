// Fork (I14): a refused assistant row reaches the Control UI as `__openclaw.refusal`
// ({ signal: "provider" | "marker", category? }) for any provider, before error projection
// drops the raw diagnostics. The model's own refusal marker is stripped from the shown text.
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { ASSISTANT_DISPLAY_CONTENT_FIELD } from "../shared/assistant-display-content.js";
import { readStoredRefusal, stripRefusalMarker } from "../shared/refusal-signal.js";

function stripMarkerFromContent(content: unknown): unknown {
  if (typeof content === "string") {
    return stripRefusalMarker(content);
  }
  if (!Array.isArray(content)) {
    return content;
  }
  return content.map((block) => {
    const entry = asOptionalRecord(block);
    return entry?.type === "text" && typeof entry.text === "string"
      ? { ...entry, text: stripRefusalMarker(entry.text) }
      : block;
  });
}

export function projectChatRefusalSignal(message: unknown): unknown {
  const refusal = readStoredRefusal(message);
  if (!refusal) {
    return message;
  }
  const record = message as Record<string, unknown>;
  const next: Record<string, unknown> = {
    ...record,
    content: stripMarkerFromContent(record.content),
    __openclaw: { ...asOptionalRecord(record["__openclaw"]), refusal },
  };
  if (typeof record.text === "string") {
    next.text = stripRefusalMarker(record.text);
  }
  if (Array.isArray(record[ASSISTANT_DISPLAY_CONTENT_FIELD])) {
    next[ASSISTANT_DISPLAY_CONTENT_FIELD] = stripMarkerFromContent(
      record[ASSISTANT_DISPLAY_CONTENT_FIELD],
    );
  }
  return next;
}
