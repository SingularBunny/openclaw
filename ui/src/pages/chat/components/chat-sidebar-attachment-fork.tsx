// Fork: PDF and Office attachments with a file source also open in the reader from the sidebar,
// through the same download source. Kept out of chat-sidebar-attachment.tsx so upstream changes
// there merge without conflicts.
import { createMemo, Show } from "solid-js";
import { isOfficeAttachment, officePdfTransform } from "./chat-office-preview.ts";
import { ChatPdfPreview, isPdfAttachment } from "./chat-pdf-preview.tsx";
import type { AttachmentSidebarRuntime, SidebarContent } from "./chat-sidebar-content-types.ts";

export function SidebarAttachmentReader(props: {
  content: Extract<SidebarContent, { kind: "attachment" }>;
  runtime: AttachmentSidebarRuntime;
}) {
  const readerKind = createMemo(() => {
    if (!props.content.file) {
      return null;
    }
    const mimeType = props.content.mimeType ?? "";
    return isPdfAttachment(mimeType, props.content.title)
      ? "pdf"
      : isOfficeAttachment(mimeType, props.content.title)
        ? "office"
        : null;
  });
  return (
    <Show when={readerKind()}>
      {(kind) => (
        <ChatPdfPreview
          src=""
          sourceIdentity={[
            props.runtime.connectionEpoch ?? "",
            props.runtime.agentId ?? "",
            props.runtime.sessionKey ?? "",
            props.content.sourceIdentity ?? props.content.title,
          ].join("\u0000")}
          label={props.content.title}
          mimeType={props.content.mimeType ?? ""}
          sizeBytes={props.content.sizeBytes}
          file={props.content.file}
          transform={
            kind() === "office" ? officePdfTransform(props.runtime, props.content.title) : undefined
          }
        />
      )}
    </Show>
  );
}
