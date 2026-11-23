import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FORGET_GIT_PLACEHOLDER,
  pushRewrittenBranch,
  redactCommitMessage,
  rewriteCommitMessages,
  rewriteTopicText,
} from "./topic-forget-git-apply-fork.js";

const hasFilterRepo = (() => {
  try {
    execFileSync("git", ["filter-repo", "--version"], { stdio: "ignore", cwd: os.tmpdir() });
    return true;
  } catch {
    return false;
  }
})();

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const env = {
  ...process.env,
  GIT_AUTHOR_NAME: "Owner",
  GIT_AUTHOR_EMAIL: "owner@example.test",
  GIT_COMMITTER_NAME: "Owner",
  GIT_COMMITTER_EMAIL: "owner@example.test",
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { env, encoding: "utf8" }).trim();
const temp = () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "forget-git-apply-")));
  dirs.push(dir);
  return dir;
};

describe("rewriteTopicText (N15)", () => {
  it("keeps a model rewrite only when the topic is gone, and the placeholder otherwise", async () => {
    const text = "Fix timer\n\nAlso filed the taxes return and fixed the clock.\n\nTaxes again.";
    const seen: string[] = [];
    const rewrite = async (paragraph: string) => {
      seen.push(paragraph);
      if (paragraph.startsWith("Also")) {
        return "Also fixed the clock.";
      }
      return "Taxes, still."; // the model left the topic in: not accepted
    };
    expect(await rewriteTopicText(text, "taxes", rewrite)).toBe(
      `Fix timer\n\nAlso fixed the clock.\n\n${FORGET_GIT_PLACEHOLDER}\n`,
    );
    // Only the paragraphs that name the topic go to the model.
    expect(seen).toEqual(["Also filed the taxes return and fixed the clock.", "Taxes again."]);
    // Nothing left of a paragraph: it is dropped; a failing model: the placeholder.
    expect(await rewriteTopicText("Fix timer\n\nTaxes.", "taxes", async () => "")).toBe(
      "Fix timer\n",
    );
    const down = async () => {
      throw new Error("model unavailable");
    };
    expect(await rewriteTopicText("Taxes.", "taxes", down)).toBe(`${FORGET_GIT_PLACEHOLDER}\n`);
    // Without a model it is the plain redaction.
    expect(await rewriteTopicText(text, "taxes")).toBe(redactCommitMessage(text, "taxes"));
  });
});

describe("redactCommitMessage (N15)", () => {
  it("replaces the paragraphs that name the topic and never leaves the message empty", () => {
    expect(redactCommitMessage("Fix timer\n\nAlso filed the taxes return.", "taxes")).toBe(
      `Fix timer\n\n${FORGET_GIT_PLACEHOLDER}\n`,
    );
    expect(redactCommitMessage("Налоги: подать декларацию", "налоги")).toBe(
      `${FORGET_GIT_PLACEHOLDER}\n`,
    );
    expect(redactCommitMessage("Fix timer", "taxes")).toBe("Fix timer\n");
  });
});

describe.skipIf(!hasFilterRepo)("rewriteCommitMessages (N15, git filter-repo)", () => {
  it("rewrites the ticked messages, keeps a bundle, and force-pushes only on request", async () => {
    const server = temp();
    git(server, "init", "-q", "--bare", "-b", "main");
    const work = temp();
    git(work, "init", "-q", "-b", "main");
    git(work, "remote", "add", "origin", server);
    git(work, "commit", "-q", "--allow-empty", "-m", "Add garden plan");
    git(work, "commit", "-q", "--allow-empty", "-m", "Taxes: file the return");
    git(work, "commit", "-q", "--allow-empty", "-m", "Fix watering timer");
    git(work, "push", "-q", "-u", "origin", "main");
    const taxes = git(work, "rev-parse", "HEAD~1");
    const oldTip = git(work, "rev-parse", "HEAD");
    const backupDir = path.join(temp(), "backups");

    const result = await rewriteCommitMessages({
      repo: work,
      rewrites: [{ repo: work, hash: taxes, message: `${FORGET_GIT_PLACEHOLDER}\n` }],
      backupDir,
    });

    expect(git(work, "log", "--format=%s", "main")).toBe(
      ["Fix watering timer", FORGET_GIT_PLACEHOLDER, "Add garden plan"].join("\n"),
    );
    expect(fs.existsSync(result.backup)).toBe(true);
    expect(git(work, "remote")).toBe("origin");
    // The server still has the old history until the confirmed push.
    expect(git(server, "rev-parse", "main")).toBe(oldTip);
    expect(result.push).toEqual([
      expect.objectContaining({
        branch: "main",
        remote: "origin",
        remoteBranch: "main",
        expected: oldTip,
      }),
    ]);

    await pushRewrittenBranch(result.push[0]!);
    expect(git(server, "log", "--format=%s", "main")).toContain(FORGET_GIT_PLACEHOLDER);
    expect(git(server, "log", "--format=%s", "main")).not.toContain("Taxes");
  });

  it("refuses a repository with uncommitted changes", async () => {
    const work = temp();
    git(work, "init", "-q", "-b", "main");
    git(work, "commit", "-q", "--allow-empty", "-m", "Taxes");
    fs.writeFileSync(path.join(work, "draft.txt"), "x");
    await expect(
      rewriteCommitMessages({
        repo: work,
        rewrites: [],
        backupDir: path.join(temp(), "b"),
      }),
    ).rejects.toThrow(/uncommitted changes/);
  });

  it("does not push over a remote that moved since the rewrite (lease)", async () => {
    const server = temp();
    git(server, "init", "-q", "--bare", "-b", "main");
    const work = temp();
    git(work, "init", "-q", "-b", "main");
    git(work, "remote", "add", "origin", server);
    git(work, "commit", "-q", "--allow-empty", "-m", "Taxes");
    git(work, "push", "-q", "-u", "origin", "main");
    const result = await rewriteCommitMessages({
      repo: work,
      rewrites: [{ repo: work, hash: git(work, "rev-parse", "HEAD"), message: "[removed]\n" }],
      backupDir: path.join(temp(), "b"),
    });
    // Someone else pushes meanwhile.
    const other = temp();
    git(other, "clone", "-q", server, ".");
    git(other, "commit", "-q", "--allow-empty", "-m", "Colleague's work");
    git(other, "push", "-q", "origin", "main");
    await expect(pushRewrittenBranch(result.push[0]!)).rejects.toThrow();
    expect(git(server, "log", "--format=%s", "main")).toContain("Colleague's work");
  });
});
