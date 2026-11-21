// Fork: Office and other non-PDF attachments reach the model as text through plugin document
// extractors (api.registerDocumentExtractor), under the same timeout and text limits as PDFs.
// Kept out of input-files.ts so upstream changes there merge without conflicts.
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import type { DocumentExtractionMetadata } from "../plugins/document-extractor-types.js";
import type { InputFileLimits } from "./input-files.js";
import { extractDocumentContent, type PdfExtractedImage } from "./pdf-extract.js";

type InputDocumentExtractResult = {
  filename: string;
  text?: string;
  images?: PdfExtractedImage[];
  metadata?: DocumentExtractionMetadata;
};

async function runDocumentExtraction<T>(params: {
  label: string;
  timeoutMs: number;
  signal?: AbortSignal;
  extract: (signal: AbortSignal) => Promise<T>;
}): Promise<T> {
  const timeoutMs = resolveTimerTimeoutMs(params.timeoutMs, 1);
  const controller = new AbortController();
  const signal = params.signal
    ? AbortSignal.any([params.signal, controller.signal])
    : controller.signal;
  signal.throwIfAborted();
  const timeout = setTimeout(
    () => controller.abort(new Error(`${params.label} timed out after ${timeoutMs}ms`)),
    timeoutMs,
  );
  try {
    return await racePromiseWithAbortSignal(
      () => params.extract(signal),
      signal,
      (abortedSignal) => toErrorObject(abortedSignal.reason, "Input file extraction aborted"),
    );
  } finally {
    clearTimeout(timeout);
  }
}

function toBoundedDocumentResult(
  filename: string,
  extracted: { text: string; images: PdfExtractedImage[]; metadata?: DocumentExtractionMetadata },
  maxChars: number,
): InputDocumentExtractResult {
  const text = truncateUtf16Safe(extracted.text, maxChars);
  const metadata: DocumentExtractionMetadata = {
    ...extracted.metadata,
    textTruncated:
      extracted.metadata?.textTruncated === true || text.length < extracted.text.length,
    imagesTruncated: extracted.metadata?.imagesTruncated === true,
  };
  return {
    filename,
    text,
    images: extracted.images.length > 0 ? extracted.images : undefined,
    metadata,
  };
}

/**
 * Extracts a non-PDF document through the first enabled plugin extractor that declares one of
 * the candidate MIME types, under the same timeout and text limits as PDFs. Returns null when
 * no extractor declares them or the matching extractor declines the bytes.
 */
export async function extractPluginDocumentFromBuffer(params: {
  buffer: Buffer;
  filename?: string;
  mimeTypes: readonly string[];
  limits: InputFileLimits;
  config?: OpenClawConfig;
  signal?: AbortSignal;
}): Promise<InputDocumentExtractResult | null> {
  const { buffer, limits } = params;
  for (const mimeType of new Set(params.mimeTypes)) {
    const extracted = await runDocumentExtraction({
      label: "Document extraction",
      timeoutMs: limits.timeoutMs,
      signal: params.signal,
      extract: (signal) =>
        extractDocumentContent({
          buffer,
          mimeType,
          signal,
          maxPages: limits.pdf.maxPages,
          maxPixels: limits.pdf.maxPixels,
          minTextChars: limits.pdf.minTextChars,
          ...(params.config ? { config: params.config } : {}),
        }),
    });
    if (extracted) {
      const { extractor: _extractor, ...content } = extracted;
      return toBoundedDocumentResult(params.filename || "file", content, limits.maxChars);
    }
  }
  return null;
}
