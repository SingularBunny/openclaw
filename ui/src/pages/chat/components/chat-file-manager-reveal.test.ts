import { describe, expect, it } from "vitest";
import { workspaceRelativeRevealPath } from "./chat-file-manager-reveal.ts";

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
