import { describe, expect, it, vi } from "vitest";
import { FileHtmlPreviewController, isMarkdownDocument } from "./chat-html-preview.ts";
import type { SidebarContent } from "./chat-sidebar-content-types.ts";

function file(name: string, content: string, mimeType?: string): SidebarContent {
  return { kind: "file", name, path: name, content, mimeType } as SidebarContent;
}

function controller(content: SidebarContent, text = () => "") {
  const host = { requestUpdate: vi.fn() };
  return { host, preview: new FileHtmlPreviewController(host, () => content, text) };
}

const options = {
  error: null,
  onRetry: () => {},
  onToggle: () => {},
  runtime: {} as never,
  mode: "scripts" as never,
};

describe("Markdown file preview", () => {
  it("recognizes Markdown by type or extension", () => {
    expect(isMarkdownDocument("text/markdown; charset=utf-8", "notes.txt")).toBe(true);
    expect(isMarkdownDocument("", "README.MD")).toBe(true);
    expect(isMarkdownDocument("", "guide.markdown")).toBe(true);
    expect(isMarkdownDocument("text/plain", "notes.txt")).toBe(false);
  });

  it("opens a Markdown file rendered and toggles to source", () => {
    const { host, preview } = controller(file("AGENTS.md", "# Title\n"), () => "# Edited\n");
    preview.reset(null, false);
    expect(preview.showing).toBe(true);
    expect(preview.controls(options)).toMatchObject({ source: false, markdown: "# Title\n" });

    preview.toggle();
    expect(host.requestUpdate).toHaveBeenCalled();
    expect(preview.controls(options)?.source).toBe(true);

    preview.toggle();
    expect(preview.controls(options)).toMatchObject({ source: false, markdown: "# Edited\n" });
  });

  it("opens the source when navigating to a line", () => {
    const { preview } = controller(file("AGENTS.md", "# Title\n"));
    preview.reset(null, true);
    expect(preview.showing).toBe(false);
    expect(preview.controls(options)?.markdown).toBeUndefined();
  });

  it("keeps HTML in the frame and other files in the editor", () => {
    const html = controller(file("page.html", "<p>x</p>")).preview;
    expect(html.file).not.toBeNull();
    const code = controller(file("main.ts", "x")).preview;
    expect(code.file).toBeNull();
  });
});
