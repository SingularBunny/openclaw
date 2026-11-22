// Fork (F34): the session's other folders in Files — where "Show in Files" finds a file and which
// folder the tree browses. Kept out of chat-session-workspace.ts so upstream ports touch less.
import { isCurrentSessionWorkspace } from "./chat-session-workspace-state.ts";
import type {
  SessionWorkspaceHost,
  SessionWorkspaceState,
} from "./chat-session-workspace-types.ts";

type RevealTarget =
  | { kind: "folder"; root: string | null; relativePath: string }
  | { kind: "outside" }
  | { kind: "unknown" };

const isAbsoluteFilePath = (value: string) => value.startsWith("/") || /^[A-Za-z]:\//.test(value);

/**
 * Fork (F34): where "Show in Files" finds a file. Root-relative paths stay in the workspace; an
 * absolute path is shown in the folder (workspace first, then the session's other folders from
 * sessions.files.list `roots`) that contains it, relative to that folder.
 */
export function resolveSessionWorkspaceRevealTarget(
  roots: readonly string[] | null | undefined,
  path: string,
): RevealTarget {
  const normalizedPath = path.replaceAll("\\", "/");
  if (!isAbsoluteFilePath(normalizedPath)) {
    return { kind: "folder", root: null, relativePath: normalizedPath };
  }
  if (!roots) {
    return { kind: "unknown" };
  }
  let best: { root: string | null; length: number } | null = null;
  for (const [index, root] of roots.entries()) {
    const base = root.replaceAll("\\", "/").replace(/\/+$/, "");
    if (normalizedPath.startsWith(`${base}/`) && (!best || base.length > best.length)) {
      best = { root: index === 0 ? null : root, length: base.length };
    }
  }
  return best
    ? { kind: "folder", root: best.root, relativePath: normalizedPath.slice(best.length + 1) }
    : { kind: "outside" };
}

/** Fork (F34): false only when the file is known to lie outside every folder Files can show. */
export function canRevealSessionWorkspaceFile(state: SessionWorkspaceHost, path: string): boolean {
  const workspace = state.sessionWorkspaceState;
  if (!workspace || !isCurrentSessionWorkspace(state, workspace)) {
    return true;
  }
  return resolveSessionWorkspaceRevealTarget(workspace.roots, path).kind !== "outside";
}

/** Fork (F34): browse another folder of the session; resets the tree, whose paths are per folder. */
export function setBrowseRoot(workspace: SessionWorkspaceState, root: string | null) {
  if ((workspace.browseRoot ?? null) !== root) {
    workspace.browseRoot = root;
    workspace.tree!.expandedPaths = [""];
  }
}
