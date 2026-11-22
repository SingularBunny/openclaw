// Fork (N15): rewrites the messages of the commits ticked in Forget a topic, and, on a separate
// confirmation, force-pushes the branches whose published commits changed.
// Tools as git recommends (standards.md ST-10): git filter-repo with --refs (a partial rewrite keeps
// the remotes and reflogs), a bundle of every ref first, and a lease naming the expected remote
// hash for the push (an implicit lease is voided by a background fetch, git-push(1)).
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { runGit, type GitRunner } from "./topic-forget-git-fork.js";

export const FORGET_GIT_PLACEHOLDER = "[removed]";

export type ForgetGitRewrite = { repo: string; hash: string; message: string };

export type ForgetGitPushPlan = {
  repo: string;
  branch: string;
  remote: string;
  remoteBranch: string;
  /** The remote branch's tip before the rewrite: the push lease. */
  expected: string;
  local: string;
};

export type ForgetGitRepoResult = {
  repo: string;
  rewritten: number;
  backup: string;
  /** Branches whose published commits changed: pushed only on confirmation. */
  push: ForgetGitPushPlan[];
};

const STEM_MIN = 4;

/** Topic words as stems, so "налоги" also matches "налогов" (as the chat's pre-selection does). */
function topicStems(topic: string): string[] {
  return topic
    .toLocaleLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 3)
    .map((word) => word.slice(0, Math.max(STEM_MIN, word.length - 2)));
}

/**
 * A commit message without the topic: each paragraph that names a topic word becomes the
 * placeholder; a subject that names it does too. The message is never empty.
 */
export function redactCommitMessage(message: string, topic: string): string {
  const stems = topicStems(topic);
  const names = (text: string) => {
    const lower = text.toLocaleLowerCase();
    return stems.some((stem) => lower.includes(stem));
  };
  const paragraphs = message
    .replace(/\r\n/g, "\n")
    .trim()
    .split(/\n{2,}/);
  const out = paragraphs.map((paragraph) =>
    names(paragraph) ? FORGET_GIT_PLACEHOLDER : paragraph,
  );
  const collapsed = out.filter(
    (paragraph, index) => !(paragraph === FORGET_GIT_PLACEHOLDER && out[index - 1] === paragraph),
  );
  return `${collapsed.join("\n\n").trim() || FORGET_GIT_PLACEHOLDER}\n`;
}

export type FilterRepoRunner = (cwd: string, args: readonly string[]) => Promise<void>;

export const runFilterRepo: FilterRepoRunner = (cwd, args) =>
  new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-C", cwd, "filter-repo", ...args],
      { maxBuffer: 64 * 1024 * 1024, timeout: 10 * 60_000 },
      (error, _stdout, stderr) =>
        error ? reject(new Error(`git filter-repo failed: ${stderr || error.message}`)) : resolve(),
    );
  });

/** The commit callback: replaces the message of the listed original commits, nothing else. */
function commitCallback(mapFile: string): string {
  return [
    "import json",
    `_m = globals().get("_forget_map") or json.load(open(${JSON.stringify(mapFile)}))`,
    'globals()["_forget_map"] = _m',
    'new = _m.get(commit.original_id.decode("ascii"))',
    "if new is not None:",
    '    commit.message = new.encode("utf-8")',
  ].join("\n");
}

async function refsToRewrite(root: string, run: GitRunner): Promise<string[]> {
  const out = await run(root, ["for-each-ref", "--format=%(refname)", "refs/heads", "refs/tags"]);
  return out.split("\n").filter(Boolean);
}

type Upstream = { branch: string; remote: string; remoteBranch: string; tracking: string };

async function upstreams(root: string, run: GitRunner): Promise<Upstream[]> {
  const out = await run(root, [
    "for-each-ref",
    "--format=%(refname:short)\u001f%(upstream:remotename)\u001f%(upstream:short)\u001f%(upstream)",
    "refs/heads",
  ]);
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [branch = "", remote = "", short = "", tracking = ""] = line.split("\u001f");
      return {
        branch,
        remote,
        remoteBranch:
          remote && short.startsWith(`${remote}/`) ? short.slice(remote.length + 1) : "",
        tracking,
      };
    })
    .filter((upstream) => upstream.remote && upstream.remoteBranch && upstream.tracking);
}

const revParse = (root: string, ref: string, run: GitRunner) =>
  run(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).then(
    (out) => out.trim(),
    () => "",
  );

/**
 * Rewrites the given commit messages in one repository. Refuses a repository with uncommitted
 * changes; keeps a bundle of every ref in `backupDir` first. Returns the branches whose remote
 * copies still hold the old commits — the push is a separate, confirmed step.
 */
export async function rewriteCommitMessages(params: {
  repo: string;
  rewrites: readonly ForgetGitRewrite[];
  backupDir: string;
  run?: GitRunner;
  filterRepo?: FilterRepoRunner;
}): Promise<ForgetGitRepoResult> {
  const run = params.run ?? runGit;
  const filterRepo = params.filterRepo ?? runFilterRepo;
  const root = (await run(params.repo, ["rev-parse", "--show-toplevel"])).trim();
  if ((await run(root, ["status", "--porcelain"])).trim()) {
    throw new Error(`${root} has uncommitted changes; commit or stash them first.`);
  }
  const rewrites = params.rewrites.filter((rewrite) => /^[0-9a-f]{40,64}$/.test(rewrite.hash));
  fs.mkdirSync(params.backupDir, { recursive: true });
  const backup = path.join(
    params.backupDir,
    `${path.basename(root).replace(/[^\w.-]+/g, "_")}-${Date.now()}.bundle`,
  );
  await run(root, ["bundle", "create", backup, "--all"]);
  const before = new Map<string, string>();
  const tracked = await upstreams(root, run);
  for (const upstream of tracked) {
    before.set(upstream.branch, await revParse(root, upstream.tracking, run));
  }
  const mapFile = path.join(params.backupDir, `${path.basename(backup, ".bundle")}.messages.json`);
  fs.writeFileSync(
    mapFile,
    JSON.stringify(Object.fromEntries(rewrites.map((rewrite) => [rewrite.hash, rewrite.message]))),
  );
  const refs = await refsToRewrite(root, run);
  await filterRepo(root, [
    "--force",
    "--refs",
    ...refs,
    "--commit-callback",
    commitCallback(mapFile),
  ]);
  const push: ForgetGitPushPlan[] = [];
  for (const upstream of tracked) {
    const local = await revParse(root, upstream.branch, run);
    const expected = before.get(upstream.branch) ?? "";
    if (!local || !expected || local === expected) {
      continue;
    }
    // Only a branch whose published history changed needs a force-push: its old remote tip is
    // no longer an ancestor of the rewritten branch.
    const contains = await run(root, ["merge-base", "--is-ancestor", expected, local]).then(
      () => true,
      () => false,
    );
    if (!contains) {
      push.push({
        repo: root,
        branch: upstream.branch,
        remote: upstream.remote,
        remoteBranch: upstream.remoteBranch,
        expected,
        local,
      });
    }
  }
  return { repo: root, rewritten: rewrites.length, backup, push };
}

/** Force-pushes one confirmed branch with a lease on the remote tip seen before the rewrite. */
export async function pushRewrittenBranch(
  plan: Pick<ForgetGitPushPlan, "repo" | "branch" | "remote" | "remoteBranch" | "expected">,
  run: GitRunner = runGit,
): Promise<void> {
  await run(plan.repo, [
    "push",
    `--force-with-lease=refs/heads/${plan.remoteBranch}:${plan.expected}`,
    plan.remote,
    `refs/heads/${plan.branch}:refs/heads/${plan.remoteBranch}`,
  ]);
}
