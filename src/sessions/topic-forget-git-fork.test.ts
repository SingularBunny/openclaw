import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionEntry } from "../agents/sessions/session-manager.js";
import {
  findForgetGitCommits,
  gitFoldersOfChat,
  gitFoldersOfCommand,
  resolveGitRepositories,
} from "./topic-forget-git-fork.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function repo(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "forget-git-")));
  dirs.push(dir);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", dir, ...args], {
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Owner",
        GIT_AUTHOR_EMAIL: "owner@example.test",
        GIT_COMMITTER_NAME: "Owner",
        GIT_COMMITTER_EMAIL: "owner@example.test",
      },
    });
  git("init", "-q");
  for (const message of ["Add garden plan", "Taxes: file the return", "Fix watering timer"]) {
    git("commit", "-q", "--allow-empty", "-m", message);
  }
  return dir;
}

// Topic "taxes" is close to a message that names it; the rest stay far.
const embedder = {
  embedQuery: async () => [1, 0],
  embedDocuments: async (texts: string[]) =>
    texts.map((text) => (/tax/i.test(text) ? [1, 0] : [0, 1])),
};

describe("Forget a topic in git (N15)", () => {
  it("finds the folders next to git in shell commands", () => {
    expect(gitFoldersOfCommand("cd /work/app && git log -1")).toEqual(["/work/app"]);
    expect(gitFoldersOfCommand('git -C "/work/my app" commit -m x')).toEqual(["/work/my app"]);
    expect(gitFoldersOfCommand("git status", "/work/here")).toEqual(["/work/here"]);
    expect(gitFoldersOfCommand("ls -la", "/work/here")).toEqual([]);
  });

  it("collects the working folders and the folders of the chat's git commands", () => {
    const entries = [
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "toolCall", name: "Bash", arguments: { command: "git -C /repo/a log" } },
            { type: "tool_use", name: "Bash", input: { command: "cd /repo/b; git push" } },
            { type: "toolCall", name: "Bash", arguments: { command: "echo no git here" } },
          ],
        },
      },
      { type: "message", message: { role: "user", content: "cd /repo/c && git push" } },
    ] as unknown as SessionEntry[];
    expect(gitFoldersOfChat(entries, ["/work", undefined]).toSorted()).toEqual([
      "/repo/a",
      "/repo/b",
      "/work",
    ]);
  });

  it("ranks the commit messages of the repositories, marking unpushed ones", async () => {
    const dir = repo();
    const repositories = await resolveGitRepositories([path.join(dir), "/does/not/exist"]);
    expect(repositories).toEqual([{ root: dir, remotes: [] }]);
    const commits = await findForgetGitCommits({ repositories, topic: "taxes", embedder });
    expect(commits[0]).toMatchObject({
      repo: dir,
      subject: "Taxes: file the return",
      pushed: false,
      selected: true,
    });
    expect(commits.filter((commit) => commit.selected)).toHaveLength(1);
    expect(commits).toHaveLength(3);
  });
});
