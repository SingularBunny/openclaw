import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveRevealFolder, selectRevealRoot } from "./sessions-files-reveal-target.js";

describe("resolveRevealFolder", () => {
  let base: string;
  let root: string;

  beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), "reveal-")));
    root = join(base, "workspace");
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(join(root, "docs", "notes.md"), "x");
    await writeFile(join(base, "outside.md"), "x");
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it("opens the workspace itself without a path", async () => {
    await expect(resolveRevealFolder(root, undefined)).resolves.toEqual({ ok: true, folder: root });
  });

  it("opens the folder that holds a file", async () => {
    await expect(resolveRevealFolder(root, "docs/notes.md")).resolves.toEqual({
      ok: true,
      folder: join(root, "docs"),
    });
  });

  it("opens a folder path as is", async () => {
    await expect(resolveRevealFolder(root, "docs")).resolves.toEqual({
      ok: true,
      folder: join(root, "docs"),
    });
  });

  it("refuses absolute paths, parent segments and missing files", async () => {
    for (const path of [
      join(base, "outside.md"),
      "../outside.md",
      "docs/../../outside.md",
      "C:/x",
    ]) {
      expect((await resolveRevealFolder(root, path)).ok).toBe(false);
    }
    expect((await resolveRevealFolder(root, "docs/missing.md")).ok).toBe(false);
  });

  it("refuses a link that leads out of the workspace", async () => {
    await symlink(join(base, "outside.md"), join(root, "link.md"));
    expect((await resolveRevealFolder(root, "link.md")).ok).toBe(false);
  });
});

describe("selectRevealRoot", () => {
  const workspaceRoot = join(tmpdir(), "reveal-root", "workspace");
  const runCwd = join(tmpdir(), "reveal-root", "chats", "shop");
  const select = (requested: string | undefined, authorized = true) => {
    const authorize = vi.fn(async () => authorized);
    return {
      authorize,
      result: selectRevealRoot({
        requested,
        workspaceRoot,
        runCwd,
        spawnedCwd: undefined,
        authorize,
      }),
    };
  };

  it("keeps the workspace without a requested root and never asks for host reads", async () => {
    for (const requested of [undefined, "", workspaceRoot]) {
      const { authorize, result } = select(requested);
      await expect(result).resolves.toEqual({ ok: true, root: workspaceRoot });
      expect(authorize).not.toHaveBeenCalled();
    }
  });

  it("allows the run cwd only with host-read authority", async () => {
    await expect(select(runCwd).result).resolves.toEqual({ ok: true, root: runCwd });
    await expect(select(runCwd, false).result).resolves.toMatchObject({ ok: false });
  });

  it("refuses any other path without asking for host reads", async () => {
    for (const requested of [join(runCwd, "notes"), join(tmpdir(), "elsewhere"), "shop", "/"]) {
      const { authorize, result } = select(requested);
      await expect(result).resolves.toMatchObject({ ok: false });
      expect(authorize).not.toHaveBeenCalled();
    }
  });
});
