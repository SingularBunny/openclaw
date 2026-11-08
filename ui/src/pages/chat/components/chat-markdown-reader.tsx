import { onSettled } from "solid-js";
import { MarkdownBlocks } from "../../../components/markdown-blocks-owner.ts";
import { createMarkdownRef } from "../../../components/markdown-dom-ref.ts";
import { toSanitizedMarkdownHtml } from "../../../components/markdown.ts";
import { detectTextDirection } from "../../../lib/text-direction.ts";

/** Sanitized rich-text reading view shared by text attachments and workspace files. */
export function MarkdownReader(props: { text: string; label: string }) {
  let article!: HTMLElement;
  const markdown = createMarkdownRef(() => ({
    content: toSanitizedMarkdownHtml(props.text, {
      mode: "document",
      remoteImages: false,
      codeBlockInteraction: "interactive",
    }),
  }));
  onSettled(() => {
    const blocks = new MarkdownBlocks(article);
    blocks.update(true);
    return () => blocks.dispose();
  });
  return (
    <article
      ref={(element) => {
        article = element;
        markdown(element);
      }}
      class="sidebar-attachment-preview__markdown sidebar-markdown-reader sidebar-markdown"
      dir={detectTextDirection(props.text)}
      aria-label={props.label}
    />
  );
}
