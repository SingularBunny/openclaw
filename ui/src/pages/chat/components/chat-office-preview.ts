import { normalizeRouteBasePath } from "@openclaw/uirouter";
import { fetchWithControlUiAuth } from "../../../app/control-ui-auth.ts";
import { resolveAttachmentSource } from "./chat-message-attachment-source.ts";
import { PdfPreviewUnavailableError } from "./chat-pdf-preview.ts";
import type {
  AttachmentSidebarRuntime,
  AttachmentSidebarState,
  SidebarContent,
} from "./chat-sidebar-content-types.ts";

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
      // The plugin explains a refusal in `{ error }` (e.g. "file is larger than 64 MB"); show it.
      const reason = await response
        .json()
        .then((body: unknown) => (body as { error?: unknown } | null)?.error)
        .catch(() => undefined);
      throw typeof reason === "string" && reason
        ? new PdfPreviewUnavailableError(reason)
        : new Error(`Office preview conversion failed: ${response.status}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  };
}

/**
 * A session workspace Office file opens as an attachment preview: its bytes come through the
 * ticketed assistant-media route, which resolves the path against the session and its allowed
 * folders, and the reader shows the plugin's PDF rendition.
 */
export function officeWorkspaceFileSidebarContent(file: {
  name: string;
  path: string;
  mimeType?: string;
  size?: number;
  updatedAtMs?: number;
  sessionKey?: string;
}): SidebarContent {
  const attachment = {
    url: file.path,
    kind: "document" as const,
    label: file.name,
    ...(file.mimeType ? { mimeType: file.mimeType } : {}),
    ...(typeof file.size === "number" ? { sizeBytes: file.size } : {}),
  };
  return {
    kind: "attachment",
    attachmentKind: "document",
    title: file.name,
    mimeType: file.mimeType ?? null,
    sourceIdentity: `workspace:${file.sessionKey ?? ""}:${file.path}:${file.updatedAtMs ?? ""}`,
    ...(typeof file.size === "number" ? { sizeBytes: file.size } : {}),
    resolveSource: (onRequestUpdate, runtime): AttachmentSidebarState => {
      const next = resolveAttachmentSource(attachment, {
        ...runtime,
        ...(file.sessionKey ? { sessionKey: file.sessionKey } : {}),
        onRequestUpdate,
      });
      if (next.status === "available") {
        return { status: "ready", ...next.source };
      }
      if (next.status === "checking") {
        return { status: "pending" };
      }
      return next.error
        ? { status: "error", reason: next.reason ?? "unavailable", onRetry: next.onRetry }
        : { status: "unavailable", onRetry: next.onRetry };
    },
  };
}
