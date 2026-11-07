import { normalizeRouteBasePath } from "@openclaw/uirouter";
import { fetchWithControlUiAuth } from "../../../app/control-ui-auth.ts";
import type { AttachmentSidebarRuntime } from "./chat-sidebar-content-types.ts";

const OFFICE_EXTENSION = /\.(?:docx|doc|odt|rtf|xlsx|xls|ods|pptx|ppt|odp)$/i;
const OFFICE_MIME_TYPES = new Set([
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/rtf",
  "text/rtf",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.oasis.opendocument.spreadsheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.oasis.opendocument.presentation",
]);

/** A converter plugin (e.g. LibreOffice) serves this route; without it the preview falls back to download. */
export const OFFICE_PREVIEW_CONVERT_PATH = "/api/office-preview/convert";

export function isOfficeAttachment(rawMimeType: string, filename: string): boolean {
  const mimeType = rawMimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return OFFICE_MIME_TYPES.has(mimeType) || OFFICE_EXTENSION.test(filename);
}

/** Bytes of an Office document → bytes of its PDF rendition, converted by the gateway plugin. */
export function officePdfTransform(
  runtime: Pick<AttachmentSidebarRuntime, "authToken" | "resourceBasePath">,
  filename: string,
) {
  return async (bytes: Uint8Array, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> => {
    const url = `${normalizeRouteBasePath(runtime.resourceBasePath ?? "")}${OFFICE_PREVIEW_CONVERT_PATH}?${new URLSearchParams({ name: filename })}`;
    const response = await fetchWithControlUiAuth(
      url,
      {
        method: "POST",
        body: new Blob([bytes as BlobPart]),
        headers: { "Content-Type": "application/octet-stream" },
        signal,
      },
      runtime.authToken ? [runtime.authToken] : [],
      () => !signal.aborted,
    );
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`Office preview conversion failed: ${response.status}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  };
}
