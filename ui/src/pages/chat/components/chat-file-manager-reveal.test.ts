import { afterEach, describe, expect, it, vi } from "vitest";
import { workspaceRelativeRevealPath } from "./chat-file-manager-reveal.ts";
import { downloadSidebarFile } from "./chat-sidebar-file-view.tsx";

describe("workspaceRelativeRevealPath", () => {
  const roots = ["/home/u/project", "/home/u/run-cwd"];

  it("keeps a relative path as is", () => {
    expect(workspaceRelativeRevealPath(roots, "docs/a.md")).toBe("docs/a.md");
  });

  it("maps an absolute path inside the workspace to a relative one", () => {
    expect(workspaceRelativeRevealPath(roots, "/home/u/project/docs/a.md")).toBe("docs/a.md");
  });

  it("offers nothing for another browse root, a file outside, or unknown roots", () => {
    expect(workspaceRelativeRevealPath(roots, "/home/u/run-cwd/a.md")).toBeNull();
    expect(workspaceRelativeRevealPath(roots, "/tmp/a.md")).toBeNull();
    expect(workspaceRelativeRevealPath(null, "/home/u/project/a.md")).toBeNull();
  });
});

describe("downloadSidebarFile", () => {
  afterEach(() => vi.restoreAllMocks());

  it("saves the shown text under the file's own name", async () => {
    const clicks: Array<{ download: string; href: string }> = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicks.push({ download: this.download, href: this.href });
    });
    const created: Blob[] = [];
    vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
      created.push(blob as Blob);
      return "blob:test";
    });
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    downloadSidebarFile({
      name: "CLAUDE.md",
      path: "CLAUDE.md",
      content: "# hi",
      mimeType: "text/markdown",
    });
    expect(clicks).toEqual([{ download: "CLAUDE.md", href: "blob:test" }]);
    expect(await created[0]?.text()).toBe("# hi");
    expect(created[0]?.type).toBe("text/markdown");
  });
});
