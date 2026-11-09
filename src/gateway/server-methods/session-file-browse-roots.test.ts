import { describe, expect, it, vi } from "vitest";
import { resolveSessionBrowseRoots, selectSessionBrowseRoot } from "./session-file-browse-roots.js";

describe("resolveSessionBrowseRoots", () => {
  it("returns absolute folders outside the workspace, once each", () => {
    expect(
      resolveSessionBrowseRoots({
        root: "/data/projects/vps",
        runCwd: "/home/u/claude-desktop/VPS/",
        spawnedCwd: "/home/u/claude-desktop/VPS",
      }),
    ).toEqual(["/home/u/claude-desktop/VPS"]);
  });

  it("skips folders inside the workspace, relative paths and a missing workspace", () => {
    expect(
      resolveSessionBrowseRoots({
        root: "/data/projects/vps",
        runCwd: "/data/projects/vps/src",
        spawnedCwd: "relative/dir",
      }),
    ).toEqual([]);
    expect(resolveSessionBrowseRoots({ root: "/w", runCwd: "/w" })).toEqual([]);
    expect(resolveSessionBrowseRoots({ root: "/w", runCwd: "/w..x" })).toEqual(["/w..x"]);
    expect(resolveSessionBrowseRoots({ root: undefined, runCwd: "/x" })).toEqual([]);
  });
});

describe("selectSessionBrowseRoot", () => {
  const base = { root: "/w", browseRoots: ["/cwd"] };
  it("keeps the workspace without a request and checks the folder and authority otherwise", async () => {
    const authorize = vi.fn(async () => true);
    expect(await selectSessionBrowseRoot({ ...base, requested: undefined, authorize })).toEqual({
      kind: "ok",
    });
    expect(await selectSessionBrowseRoot({ ...base, requested: "/w", authorize })).toEqual({
      kind: "ok",
    });
    expect(authorize).not.toHaveBeenCalled();
    expect(await selectSessionBrowseRoot({ ...base, requested: "/etc", authorize })).toMatchObject({
      kind: "session_root_unavailable",
    });
    expect(await selectSessionBrowseRoot({ ...base, requested: " /cwd ", authorize })).toEqual({
      kind: "ok",
      root: "/cwd",
    });
    expect(
      await selectSessionBrowseRoot({ ...base, requested: "/cwd", authorize: async () => false }),
    ).toEqual({ kind: "denied" });
  });
});
