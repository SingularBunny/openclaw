// Fork (N15): Forget a topic in the pull requests of the chat's GitHub repositories.
// Texts: PR descriptions, conversation comments, review comments and review bodies of the PRs
// the owner took part in (GitHub search `involves:@me`). Editing on GitHub keeps the old text in
// the comment's edit history (standards.md ST-10), so the owner's own conversation comments are
// deleted and posted again cleaned; other people's are edited, or reposted on explicit request.
// Everything goes through `gh api`, signed in as the owner.
import { execFile } from "node:child_process";
import { cosineSimilarity, rankByCloseness, type ForgetEmbedder } from "./topic-forget-fork.js";

const PR_LIMIT = 50;
const PREVIEW_LIMIT = 240;

export type GhRunner = (args: readonly string[], input?: unknown) => Promise<unknown>;

export const runGh: GhRunner = (args, input) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      "gh",
      ["api", ...args, ...(input === undefined ? [] : ["--input", "-"])],
      { maxBuffer: 64 * 1024 * 1024, timeout: 60_000 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`gh api ${args[0] ?? ""} failed: ${stderr || error.message}`));
          return;
        }
        try {
          resolve(stdout.trim() ? JSON.parse(stdout) : undefined);
        } catch (parseError) {
          reject(parseError);
        }
      },
    );
    if (input !== undefined) {
      child.stdin?.end(JSON.stringify(input));
    }
  });

export type ForgetReviewKind = "pr-body" | "issue-comment" | "review-comment" | "review";

export type ForgetReviewItem = {
  host: "github";
  /** owner/name */
  repo: string;
  number: number;
  kind: ForgetReviewKind;
  /** Comment or review id; the PR number for a description. */
  id: number;
  author: string;
  mine: boolean;
  url: string;
  text: string;
};

export type ForgetReviewCandidate = Omit<ForgetReviewItem, "text"> & {
  preview: string;
  score: number;
  literal: boolean;
  selected: boolean;
};

/** owner/name of a GitHub remote (ssh or https), else undefined. */
export function githubRepoOfRemote(remote: string): string | undefined {
  const match = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(remote.trim());
  return match ? `${match[1]}/${match[2]}` : undefined;
}

type Json = Record<string, unknown>;
const asList = (value: unknown): Json[] => (Array.isArray(value) ? (value as Json[]) : []);
const login = (value: unknown) => String((value as Json | undefined)?.login ?? "");
const text = (value: unknown) => (typeof value === "string" ? value : "");

/** The texts of the PRs the owner took part in, in the given GitHub repositories. */
export async function readGithubReviewTexts(
  repos: readonly string[],
  gh: GhRunner = runGh,
): Promise<ForgetReviewItem[]> {
  if (repos.length === 0) {
    return [];
  }
  const me = login(await gh(["user"]));
  const items: ForgetReviewItem[] = [];
  for (const repo of repos) {
    const found = (await gh([
      "-X",
      "GET",
      "search/issues",
      "-f",
      `q=repo:${repo} is:pr involves:${me}`,
      "-f",
      "sort=updated",
      "-f",
      `per_page=${PR_LIMIT}`,
    ])) as Json | undefined;
    for (const pr of asList(found?.items)) {
      const number = Number(pr.number);
      const base = { host: "github" as const, repo, number };
      const author = login(pr.user);
      if (text(pr.body).trim()) {
        items.push({
          ...base,
          kind: "pr-body",
          id: number,
          author,
          mine: author === me,
          url: String(pr.html_url ?? ""),
          text: text(pr.body),
        });
      }
      const lists: Array<[ForgetReviewKind, string]> = [
        ["issue-comment", `repos/${repo}/issues/${number}/comments?per_page=100`],
        ["review-comment", `repos/${repo}/pulls/${number}/comments?per_page=100`],
        ["review", `repos/${repo}/pulls/${number}/reviews?per_page=100`],
      ];
      for (const [kind, path] of lists) {
        for (const entry of asList(await gh([path]))) {
          const body = text(entry.body);
          if (!body.trim()) {
            continue;
          }
          const who = login(entry.user);
          items.push({
            ...base,
            kind,
            id: Number(entry.id),
            author: who,
            mine: who === me,
            url: String(entry.html_url ?? ""),
            text: body,
          });
        }
      }
    }
  }
  return items;
}

const preview = (value: string) =>
  value.length > PREVIEW_LIMIT ? `${value.slice(0, PREVIEW_LIMIT - 1)}…` : value;

/** The texts ranked against the topic, closest first. */
export async function rankReviewTexts(
  items: readonly ForgetReviewItem[],
  topic: string,
  embedder: ForgetEmbedder,
): Promise<ForgetReviewCandidate[]> {
  if (items.length === 0) {
    return [];
  }
  const texts = items.map((item) => item.text);
  const [query, documents] = await Promise.all([
    embedder.embedQuery(topic),
    embedder.embedDocuments(texts),
  ]);
  const ranked = rankByCloseness(
    texts,
    documents.map((vector) => cosineSimilarity(query, vector)),
    topic,
  );
  const out: ForgetReviewCandidate[] = [];
  items.forEach(({ text: body, ...item }, index) => {
    const closeness = ranked[index]!;
    out.push({
      ...item,
      preview: preview(body),
      score: closeness.score,
      literal: closeness.literal,
      selected: closeness.selected,
    });
  });
  return out.toSorted((left, right) => right.score - left.score).slice(0, 200);
}

export type ForgetReviewTarget = Pick<ForgetReviewItem, "repo" | "number" | "kind" | "id">;

export type ForgetReviewOutcome = ForgetReviewTarget & {
  action: "edited" | "reposted";
  /** The new comment's address after a repost. */
  url?: string;
};

/**
 * Cleans one text: a description, review or review comment is edited (GitHub keeps the old
 * version in its edit history); a conversation comment is deleted and posted again when it is
 * the owner's, or when `repostOthers` is set, quoting its author.
 */
export async function cleanReviewText(params: {
  target: ForgetReviewTarget;
  redact: (text: string) => string | Promise<string>;
  repostOthers: boolean;
  gh?: GhRunner;
}): Promise<ForgetReviewOutcome> {
  const gh = params.gh ?? runGh;
  const { repo, number, kind, id } = params.target;
  if (kind === "pr-body") {
    const pr = (await gh([`repos/${repo}/pulls/${number}`])) as Json;
    await gh(["-X", "PATCH", `repos/${repo}/pulls/${number}`], {
      body: await params.redact(text(pr.body)),
    });
    return { ...params.target, action: "edited" };
  }
  if (kind === "review") {
    const review = (await gh([`repos/${repo}/pulls/${number}/reviews/${id}`])) as Json;
    await gh(["-X", "PUT", `repos/${repo}/pulls/${number}/reviews/${id}`], {
      body: await params.redact(text(review.body)),
    });
    return { ...params.target, action: "edited" };
  }
  if (kind === "review-comment") {
    const comment = (await gh([`repos/${repo}/pulls/comments/${id}`])) as Json;
    await gh(["-X", "PATCH", `repos/${repo}/pulls/comments/${id}`], {
      body: await params.redact(text(comment.body)),
    });
    return { ...params.target, action: "edited" };
  }
  const comment = (await gh([`repos/${repo}/issues/comments/${id}`])) as Json;
  const me = login(await gh(["user"]));
  const author = login(comment.user);
  const cleaned = await params.redact(text(comment.body));
  if (author !== me && !params.repostOthers) {
    await gh(["-X", "PATCH", `repos/${repo}/issues/comments/${id}`], { body: cleaned });
    return { ...params.target, action: "edited" };
  }
  // Post first, then delete: a failure never loses the comment.
  const body = author === me ? cleaned : `_Originally by @${author}:_\n\n${cleaned}`;
  const posted = (await gh(["-X", "POST", `repos/${repo}/issues/${number}/comments`], {
    body,
  })) as Json | undefined;
  await gh(["-X", "DELETE", `repos/${repo}/issues/comments/${id}`]);
  return { ...params.target, action: "reposted", url: String(posted?.html_url ?? "") };
}
