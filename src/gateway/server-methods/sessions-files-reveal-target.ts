import { stat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { execOpenPath, resolveOpenPathCommand } from "./open-path.js";

export type RevealFolderTarget = { ok: true; folder: string } | { ok: false; error: string };

/**
 * Fork: the folder `sessions.files.reveal` opens for a workspace-relative `path`. The file's own
 * folder (or the folder itself), resolved through symlinks, and only when it stays inside the
 * workspace: an absolute path, `..`, or a link out of the workspace is refused.
 */
export async function resolveRevealFolder(
  workspaceRoot: string,
  path: string | undefined,
): Promise<RevealFolderTarget> {
  if (!path) {
    return { ok: true, folder: workspaceRoot };
  }
  const normalized = path.replaceAll("\\", "/");
  if (isAbsolute(normalized) || /^[A-Za-z]:/.test(normalized)) {
    return { ok: false, error: "The path must be relative to the session workspace." };
  }
  if (normalized.split("/").includes("..")) {
    return { ok: false, error: "The path must stay inside the session workspace." };
  }
  let root: string;
  let target: string;
  try {
    root = await realpath(workspaceRoot);
    target = await realpath(resolve(workspaceRoot, normalized));
  } catch {
    return { ok: false, error: "The file was not found in the session workspace." };
  }
  const inside = relative(root, target);
  if (inside.startsWith(`..${sep}`) || inside === ".." || isAbsolute(inside)) {
    return { ok: false, error: "The path must stay inside the session workspace." };
  }
  const isFolder = (await stat(target)).isDirectory();
  return { ok: true, folder: isFolder ? target : dirname(target) };
}

/**
 * Opens the folder for `path` on the Gateway host and returns it. A refused path throws with the
 * reason, so the caller's error reply carries it.
 */
export async function openRevealFolder(
  workspaceRoot: string,
  path: string | undefined,
  assertCurrent: () => void,
): Promise<string> {
  const target = await resolveRevealFolder(workspaceRoot, path);
  if (!target.ok) {
    throw new Error(target.error);
  }
  assertCurrent();
  await execOpenPath(resolveOpenPathCommand(target.folder));
  return target.folder;
}
