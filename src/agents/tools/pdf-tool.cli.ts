/**
 * Fork: the pdf tool on a CLI runtime (media-tool-cli.ts) extracts locally as for any non-native model (text,
 * scanned pages rendered to images) and sends that as one isolated CLI turn.
 */
import type { Context, ImageContent } from "../../llm/types.js";

/** The extraction context as one prompt and its images, in the order the context gives them. */
export function pdfCliPrompt(context: Context): { prompt: string; images: ImageContent[] } {
  const texts: string[] = [];
  const images: ImageContent[] = [];
  for (const message of context.messages) {
    if (message.role !== "user") {
      continue;
    }
    if (typeof message.content === "string") {
      texts.push(message.content);
      continue;
    }
    for (const part of message.content) {
      if (part.type === "text") {
        texts.push(part.text);
      } else if (part.type === "image") {
        images.push({ type: "image", data: part.data, mimeType: part.mimeType });
      }
    }
  }
  return { prompt: texts.join("\n\n"), images };
}
