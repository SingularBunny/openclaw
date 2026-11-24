import { describe, expect, it } from "vitest";
import {
  cleanReviewText,
  githubRepoOfRemote,
  rankReviewTexts,
  readGithubReviewTexts,
  type GhRunner,
} from "./topic-forget-review-fork.js";

const redact = (value: string) => value.replace(/taxes/gi, "[removed]");

function fakeGh(responses: Record<string, unknown>) {
  const calls: Array<{ args: readonly string[]; input?: unknown }> = [];
  const gh: GhRunner = async (args, input) => {
    calls.push({ args, input });
    const key = args.find(
      (arg) => !arg.startsWith("-") && !/^(GET|PATCH|PUT|POST|DELETE)$/.test(arg),
    )!;
    return responses[`${args.includes("-X") ? args[args.indexOf("-X") + 1] : "GET"} ${key}`];
  };
  return { gh, calls };
}

describe("Forget a topic in GitHub pull requests (N15)", () => {
  it("reads the owner and name of GitHub remotes only", () => {
    expect(githubRepoOfRemote("git@github.com:owner/app.git")).toBe("owner/app");
    expect(githubRepoOfRemote("https://github.com/owner/app")).toBe("owner/app");
    expect(githubRepoOfRemote("git@gitlab.example.test:team/app.git")).toBeUndefined();
  });

  it("collects descriptions, comments, review comments and reviews of the PRs the owner joined", async () => {
    const { gh, calls } = fakeGh({
      "GET user": { login: "me" },
      "GET search/issues": {
        items: [{ number: 7, body: "Plan for taxes", user: { login: "me" }, html_url: "u7" }],
      },
      "GET repos/o/r/issues/7/comments?per_page=100": [
        { id: 1, body: "taxes again", user: { login: "colleague" }, html_url: "c1" },
      ],
      "GET repos/o/r/pulls/7/comments?per_page=100": [],
      "GET repos/o/r/pulls/7/reviews?per_page=100": [{ id: 9, body: "", user: { login: "me" } }],
    });
    const items = await readGithubReviewTexts(["o/r"], gh);
    expect(items.map((item) => [item.kind, item.id, item.mine])).toEqual([
      ["pr-body", 7, true],
      ["issue-comment", 1, false],
    ]);
    expect(calls[1]!.args).toContain("q=repo:o/r is:pr involves:me");
    const ranked = await rankReviewTexts(items, "taxes", {
      embedQuery: async () => [1, 0],
      embedDocuments: async (texts) => texts.map(() => [1, 0]),
    });
    expect(ranked.every((item) => item.literal)).toBe(true);
    expect(ranked[0]).not.toHaveProperty("text");
  });

  it("reposts the owner's comment cleaned and deletes the old one; edits a colleague's", async () => {
    const own = fakeGh({
      "GET user": { login: "me" },
      "GET repos/o/r/issues/comments/1": { body: "about taxes", user: { login: "me" } },
      "POST repos/o/r/issues/7/comments": { html_url: "new" },
    });
    const target = { repo: "o/r", number: 7, kind: "issue-comment" as const, id: 1 };
    await expect(
      cleanReviewText({ target, redact, repostOthers: false, gh: own.gh }),
    ).resolves.toMatchObject({ action: "reposted", url: "new" });
    const methods = own.calls.map((call) => call.args.slice(0, 3).join(" "));
    // Post first, delete after: a failed post never loses the comment.
    expect(methods.findIndex((m) => m.includes("POST"))).toBeLessThan(
      methods.findIndex((m) => m.includes("DELETE")),
    );
    expect(own.calls.find((call) => call.args.includes("POST"))!.input).toEqual({
      body: "about [removed]",
    });

    const theirs = fakeGh({
      "GET user": { login: "me" },
      "GET repos/o/r/issues/comments/1": { body: "about taxes", user: { login: "colleague" } },
    });
    await expect(
      cleanReviewText({ target, redact, repostOthers: false, gh: theirs.gh }),
    ).resolves.toMatchObject({ action: "edited" });
    expect(theirs.calls.some((call) => call.args.includes("DELETE"))).toBe(false);

    const reposted = fakeGh({
      "GET user": { login: "me" },
      "GET repos/o/r/issues/comments/1": { body: "about taxes", user: { login: "colleague" } },
      "POST repos/o/r/issues/7/comments": { html_url: "n" },
    });
    await cleanReviewText({ target, redact, repostOthers: true, gh: reposted.gh });
    expect(reposted.calls.find((call) => call.args.includes("POST"))!.input).toEqual({
      body: "_Originally by @colleague:_\n\nabout [removed]",
    });
  });

  it("edits a PR description in place", async () => {
    const { gh, calls } = fakeGh({ "GET repos/o/r/pulls/7": { body: "taxes plan" } });
    await cleanReviewText({
      target: { repo: "o/r", number: 7, kind: "pr-body", id: 7 },
      redact,
      repostOthers: true,
      gh,
    });
    expect(calls.at(-1)).toEqual({
      args: ["-X", "PATCH", "repos/o/r/pulls/7"],
      input: { body: "[removed] plan" },
    });
  });
});
