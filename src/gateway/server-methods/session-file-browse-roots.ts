import path from "node:path";

/**
 * Fork (F34): folders the Files panel may browse besides the session workspace. A project agent's
 * workspace and the folder its CLI runs in (agents.list[].cwd, or the session's own cwd) can differ,
 * so files the agent reads and writes there lie outside the workspace and "Show in Files" had no
 * folder to open. Returned in sessions.files.list `roots` and accepted back as its `root` param;
 * browsing one still needs the session's host-read authority.
 */
export function resolveSessionBrowseRoots(params: {
  root: string | undefined;
  runCwd?: string | undefined;
  spawnedCwd?: string | undefined;
}): string[] {
  if (!params.root) {
    return [];
  }
  const root = path.resolve(params.root);
  const roots: string[] = [];
  for (const candidate of [params.runCwd, params.spawnedCwd]) {
    const trimmed = candidate?.trim();
    if (!trimmed || !path.isAbsolute(trimmed)) {
      continue;
    }
    const resolved = path.resolve(trimmed);
    const relative = path.relative(root, resolved);
    const insideRoot =
      relative === "" ||
      (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    if (!insideRoot && !roots.includes(resolved)) {
      roots.push(resolved);
    }
  }
  return roots;
}

/**
 * The folder one sessions.files.list request browses: the workspace, or one of `browseRoots` when the
 * session may read outside its workspace (host-read authority, as for out-of-root files).
 */
export async function selectSessionBrowseRoot(params: {
  requested: string | undefined;
  root: string | undefined;
  browseRoots: readonly string[];
  authorize: () => Promise<boolean>;
}): Promise<
  | { kind: "ok"; root?: string }
  | { kind: "denied" }
  | { kind: "session_root_unavailable"; message: string }
> {
  const requested = params.requested?.trim();
  if (!requested || requested === params.root) {
    return { kind: "ok" };
  }
  if (!params.browseRoots.includes(requested)) {
    return {
      kind: "session_root_unavailable",
      message: "this folder is not available for the session",
    };
  }
  if (!(await params.authorize())) {
    return { kind: "denied" };
  }
  return { kind: "ok", root: requested };
}
