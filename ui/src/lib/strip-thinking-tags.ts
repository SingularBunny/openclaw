import { stripRefusalMarker } from "../../../src/shared/refusal-signal.js";
import { stripAssistantInternalScaffolding } from "../../../src/shared/text/assistant-internal-scaffolding.js";

/** Assistant text as shown: no internal scaffolding, and (fork, I14) no refusal marker. */
export function stripThinkingTags(text: string): string {
  return stripRefusalMarker(stripAssistantInternalScaffolding(text));
}
