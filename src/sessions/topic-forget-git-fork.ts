// Fork (N15): Forget a topic also looks at the git repositories the chat's model worked in.
// Read-only here: the repositories are the session's working folder plus every folder a git
// command of the chat ran in; each commit message is ranked against the topic with the same
// embedding model and pre-selection rule as the chat's turns (topic-forget-fork.ts).
import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { SessionEntry } from "../agents/sessions/session-manager.js";
import { cosineSimilarity, rankByCloseness, type ForgetEmbedder } from "./topic-forget-fork.js";

const PREVIEW_LIMIT = 240;
/** Newest commits per repository that are ranked; older history is not searched. */
export const FORGET_GIT_COMMIT_LIMIT = 2000;
const MAX_REPOSITORIES = 20;
/** Commit messages ranked in one search, newest first across repositories. */
const MAX_COMMITS = 5000;
const RECORD = "\u001e";
const FIELD = "\u001f";

export type GitRunner = (cwd: string, args: readonly string[]) => Promise<string>;

export const runGit: GitRunner = (cwd, args) =>
  new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-C", cwd, ...args],
      { maxBuffer: 64 * 1024 * 1024, timeout: 60_000, env: { ...process.env, GIT_PAGER: "cat" } },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });

export type ForgetGitCommit = {
  repo: string;
  hash: string;
  author: string;
  date: string;
  subject: string;
  preview: string;
  /** False while the commit is on no remote-tracking branch: rewriting it needs no force-push. */
  pushed: boolean;
  score: number;
  literal: boolean;
  selected: boolean;
};

export type ForgetGitRepository = { root: string; remotes: string[] };

const QUOTED = /^(["'])(.*)\1$/;
const unquote = (value: string) => value.replace(QUOTED, "$2");

/** Folders named next to git in one shell command: `git -C <dir>`, `cd <dir> && git ...`. */
export function gitFoldersOfCommand(command: string, cwd?: string): string[] {
  if (!/\bgit\b/.test(command)) {
    return [];
  }
  const folders: string[] = [];
  const add = (value: string) => {
    const folder = unquote(value.trim());
    if (folder && !folder.startsWith("-")) {
      folders.push(path.isAbsolute(folder) || !cwd ? folder : path.resolve(cwd, folder));
    }
  };
  for (const match of command.matchAll(/\bgit\s+-C\s+("[^"]+"|'[^']+'|\S+)/g)) {
    add(match[1]!);
  }
  for (const match of command.matchAll(/(?:^|[;&|(]\s*)cd\s+("[^"]+"|'[^']+'|[^\s;&|)]+)/g)) {
    add(match[1]!);
  }
  if (cwd && folders.length === 0) {
    folders.push(cwd);
  }
  return folders;
}

function toolCallArguments(message: Record<string, unknown>): Record<string, unknown>[] {
  const content = message.content;
  if (!Array.isArray(content)) {
    return [];
  }
  const calls: Record<string, unknown>[] = [];
  for (const part of content) {
    const record = asOptionalRecord(part);
    const args = asOptionalRecord(record?.arguments ?? record?.input);
    if ((record?.type === "toolCall" || record?.type === "tool_use") && args) {
      calls.push(args);
    }
  }
  return calls;
}

/** Folders of the git commands the chat's model ran, plus the given working folders. */
export function gitFoldersOfChat(
  entries: readonly SessionEntry[],
  workingFolders: readonly (string | undefined)[],
): string[] {
  const folders = new Set<string>();
  for (const folder of workingFolders) {
    if (folder) {
      folders.add(folder);
    }
  }
  const base = workingFolders.find(Boolean);
  for (const entry of entries) {
    const message = entry.type === "message" ? asOptionalRecord(entry.message) : undefined;
    if (!message || message.role !== "assistant") {
      continue;
    }
    for (const args of toolCallArguments(message)) {
      const cwd = [args.cwd, args.workdir, args.directory].find(
        (value): value is string => typeof value === "string" && value.length > 0,
      );
      const command = [args.command, args.cmd, args.script].find(
        (value): value is string => typeof value === "string",
      );
      if (command) {
        for (const folder of gitFoldersOfCommand(command, cwd ?? base)) {
          folders.add(folder);
        }
      }
    }
  }
  return [...folders];
}

const isFolder = (folder: string) => {
  try {
    return existsSync(folder) && statSync(folder).isDirectory();
  } catch {
    return false;
  }
};

/** The repositories (top-level folders, remotes) the folders belong to; folders outside git are skipped. */
export async function resolveGitRepositories(
  folders: readonly string[],
  run: GitRunner = runGit,
): Promise<ForgetGitRepository[]> {
  const roots = new Map<string, ForgetGitRepository>();
  for (const folder of folders) {
    if (roots.size >= MAX_REPOSITORIES || !path.isAbsolute(folder) || !isFolder(folder)) {
      continue;
    }
    const root = await run(folder, ["rev-parse", "--show-toplevel"]).then(
      (out) => out.trim(),
      () => "",
    );
    if (!root || roots.has(root)) {
      continue;
    }
    const remotes = await run(root, ["remote", "-v"]).then(
      (out) => [
        ...new Set(
          out
            .split("\n")
            .map((line) => line.split(/\s+/)[1])
            .filter(Boolean),
        ),
      ],
      () => [] as string[],
    );
    roots.set(root, { root, remotes: remotes as string[] });
  }
  return [...roots.values()];
}

type RawCommit = { hash: string; author: string; date: string; message: string };

export async function readCommits(
  root: string,
  run: GitRunner = runGit,
  limit = FORGET_GIT_COMMIT_LIMIT,
): Promise<{ commits: RawCommit[]; unpushed: Set<string> }> {
  const log = await run(root, [
    "log",
    "--all",
    `-n${limit}`,
    `--format=%H${FIELD}%an${FIELD}%aI${FIELD}%B${RECORD}`,
  ]);
  const commits = log
    .split(RECORD)
    .map((record) => record.replace(/^\n/, ""))
    .filter(Boolean)
    .map((record) => {
      const [hash = "", author = "", date = "", message = ""] = record.split(FIELD);
      return { hash, author, date, message: message.trim() };
    })
    .filter((commit) => /^[0-9a-f]{40,64}$/.test(commit.hash));
  const local = await run(root, ["rev-list", "--all", "--not", "--remotes"]).then(
    (out) => out.split("\n").filter(Boolean),
    () => [] as string[],
  );
  return { commits, unpushed: new Set(local) };
}

const preview = (text: string) =>
  text.length > PREVIEW_LIMIT ? `${text.slice(0, PREVIEW_LIMIT - 1)}…` : text;

/** Commit messages of the repositories, ranked against the topic; closest first. */
export async function findForgetGitCommits(params: {
  repositories: readonly ForgetGitRepository[];
  topic: string;
  embedder: ForgetEmbedder;
  run?: GitRunner;
  limit?: number;
}): Promise<ForgetGitCommit[]> {
  const run = params.run ?? runGit;
  const all: Array<RawCommit & { repo: string; pushed: boolean }> = [];
  for (const repository of params.repositories) {
    const { commits, unpushed } = await readCommits(repository.root, run, params.limit);
    for (const commit of commits) {
      all.push({ ...commit, repo: repository.root, pushed: !unpushed.has(commit.hash) });
    }
  }
  if (all.length === 0) {
    return [];
  }
  all.sort((left, right) => right.date.localeCompare(left.date));
  all.splice(MAX_COMMITS);
  const texts = all.map((commit) => commit.message);
  const [query, documents] = await Promise.all([
    params.embedder.embedQuery(params.topic),
    params.embedder.embedDocuments(texts),
  ]);
  const ranked = rankByCloseness(
    texts,
    documents.map((vector) => cosineSimilarity(query, vector)),
    params.topic,
  );
  const out: ForgetGitCommit[] = [];
  all.forEach((commit, index) => {
    const closeness = ranked[index]!;
    out.push({
      repo: commit.repo,
      hash: commit.hash,
      author: commit.author,
      date: commit.date,
      subject: commit.message.split("\n")[0] ?? "",
      preview: preview(commit.message),
      pushed: commit.pushed,
      score: closeness.score,
      literal: closeness.literal,
      selected: closeness.selected,
    });
  });
  return out.toSorted((left, right) => right.score - left.score).slice(0, 200);
}
