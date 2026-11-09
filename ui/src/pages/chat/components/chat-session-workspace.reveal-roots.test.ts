import { describe, expect, it, vi } from "vitest";
import { getSessionWorkspace } from "./chat-session-workspace-state.ts";
import {
  canRevealSessionWorkspaceFile,
  createSessionWorkspaceProps,
  resolveSessionWorkspaceRevealTarget,
  revealSessionWorkspaceFile,
  type SessionWorkspaceHost,
} from "./chat-session-workspace.ts";

// Fork (F34): a project agent's Files root is its workspace, while its Claude CLI works in another
// folder; "Show in Files" must open that folder instead of "This folder is unavailable".
const WORKSPACE = "/home/u/ai-workbench-data/projects/vps";
const RUN_CWD = "/home/u/claude-desktop/VPS";
const sessionKey = "agent:vps:main";

function createHost() {
  const listFiles = vi.fn(async (_key: string, options: { root?: string | null } = {}) => ({
    sessionKey,
    root: options.root ?? WORKSPACE,
    roots: [WORKSPACE, RUN_CWD],
    files: [],
  }));
  const state = {
    client: { request: vi.fn().mockResolvedValue({ artifacts: [] }) } as never,
    connected: true,
    connectionEpoch: 1,
    handleOpenSidebar: vi.fn(),
    hello: null,
    agentsList: { agents: [] },
    requestUpdate: vi.fn(),
    sessionKey,
    sidebarContent: null,
    sessions: { listFiles } as never,
  } as SessionWorkspaceHost;
  return { state, listFiles };
}

describe("resolveSessionWorkspaceRevealTarget", () => {
  it("maps absolute paths to the folder that holds them, relative to it", () => {
    const roots = [WORKSPACE, RUN_CWD];
    expect(resolveSessionWorkspaceRevealTarget(roots, `${RUN_CWD}/docs/plan.md`)).toEqual({
      kind: "folder",
      root: RUN_CWD,
      relativePath: "docs/plan.md",
    });
    expect(resolveSessionWorkspaceRevealTarget(roots, `${WORKSPACE}/AGENTS.md`)).toEqual({
      kind: "folder",
      root: null,
      relativePath: "AGENTS.md",
    });
    expect(resolveSessionWorkspaceRevealTarget(roots, "src/a.ts")).toEqual({
      kind: "folder",
      root: null,
      relativePath: "src/a.ts",
    });
    expect(resolveSessionWorkspaceRevealTarget(roots, "/tmp/f28/sample.md")).toEqual({
      kind: "outside",
    });
    expect(resolveSessionWorkspaceRevealTarget(roots, `${RUN_CWD}x/a.md`)).toEqual({
      kind: "outside",
    });
    expect(resolveSessionWorkspaceRevealTarget(null, `${RUN_CWD}/a.md`)).toEqual({
      kind: "unknown",
    });
  });
});

describe("revealSessionWorkspaceFile across folders", () => {
  it("learns the folders, switches to the run cwd and selects the file", async () => {
    const { state, listFiles } = createHost();
    revealSessionWorkspaceFile(state, `${RUN_CWD}/docs/plan.md`);
    await vi.waitFor(() => expect(listFiles).toHaveBeenCalledTimes(2));
    expect(listFiles).toHaveBeenLastCalledWith(sessionKey, {
      path: "docs",
      search: "",
      agentId: "vps",
      root: RUN_CWD,
    });
    const workspace = getSessionWorkspace(state);
    expect(workspace.browseRoot).toBe(RUN_CWD);
    expect(workspace.activeId).toBe("file:docs/plan.md");
    await vi.waitFor(() => expect(workspace.loading).toBe(false));
    const props = createSessionWorkspaceProps(state);
    expect(props.roots).toEqual([WORKSPACE, RUN_CWD]);
    expect(props.browseRoot).toBe(RUN_CWD);
    expect(props.error).toBeNull();

    // Back to the workspace from the folder switch.
    props.onSelectRoot?.(WORKSPACE);
    expect(getSessionWorkspace(state).browseRoot).toBeNull();
    await vi.waitFor(() =>
      expect(listFiles).toHaveBeenLastCalledWith(sessionKey, {
        path: "",
        search: "",
        agentId: "vps",
      }),
    );
  });

  it("explains a file outside every folder and hides the button once the folders are known", async () => {
    const { state, listFiles } = createHost();
    const outside = "/tmp/f28/sample.md";
    expect(canRevealSessionWorkspaceFile(state, outside)).toBe(true);
    revealSessionWorkspaceFile(state, outside);
    await vi.waitFor(() => expect(getSessionWorkspace(state).roots).not.toBeNull());
    await vi.waitFor(() =>
      expect(getSessionWorkspace(state).error).toBe(
        "This file is outside the folders the Files panel can show.",
      ),
    );
    expect(listFiles).toHaveBeenCalledTimes(1);
    expect(getSessionWorkspace(state).browseRoot).toBeNull();
    expect(canRevealSessionWorkspaceFile(state, outside)).toBe(false);
    expect(canRevealSessionWorkspaceFile(state, `${RUN_CWD}/a.md`)).toBe(true);
  });
});
