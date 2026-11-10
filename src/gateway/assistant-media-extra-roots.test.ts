import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ASSISTANT_MEDIA_ROOTS_ENV,
  parseAssistantMediaRoots,
  resolveAssistantMediaExtraRoots,
} from "./assistant-media-extra-roots.js";

let temp: string;
let home: string;
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "assistant-roots-parse-")));
  home = path.join(temp, "home", "u");
  await fs.mkdir(path.join(home, "Desktop"), { recursive: true });
  await fs.mkdir(path.join(home, "Downloads"));
  await fs.writeFile(path.join(home, "file.txt"), "x");
  env = { HOME: home };
});
afterEach(async () => {
  await fs.rm(temp, { recursive: true, force: true });
});

describe("parseAssistantMediaRoots", () => {
  it("treats a blank value as no extra roots", () => {
    const empty = { global: [], agents: {}, warnings: [] };
    expect(parseAssistantMediaRoots(undefined, env)).toEqual(empty);
    expect(parseAssistantMediaRoots(" ; ", env)).toEqual(empty);
    expect(parseAssistantMediaRoots(" : ", env)).toEqual(empty);
  });

  it("expands ~, trims entries and drops duplicates", () => {
    const parsed = parseAssistantMediaRoots(
      ` ~/Desktop : ${path.join(home, "Downloads")} :~/Desktop/`,
      env,
    );
    expect(parsed.global).toEqual([path.join(home, "Desktop"), path.join(home, "Downloads")]);
    expect(parsed.warnings).toEqual([]);
  });

  it("ignores relative, missing and non-directory entries with a warning", () => {
    const parsed = parseAssistantMediaRoots(
      ["Desktop", path.join(home, "missing"), path.join(home, "file.txt"), "~/Downloads"].join(":"),
      env,
    );
    expect(parsed.global).toEqual([path.join(home, "Downloads")]);
    expect(parsed.warnings).toEqual([
      "ignored Desktop: not an absolute or ~ path",
      `ignored ${path.join(home, "missing")}: does not exist`,
      `ignored ${path.join(home, "file.txt")}: not a directory`,
    ]);
  });

  it("refuses the filesystem root, the home directory and folders containing it", async () => {
    const alias = path.join(temp, "home-alias");
    await fs.symlink(home, alias);
    const parsed = parseAssistantMediaRoots(
      ["/", "~", `${home}/`, alias, path.dirname(home), "~/Desktop"].join(":"),
      env,
    );
    expect(parsed.global).toEqual([path.join(home, "Desktop")]);
    expect(parsed.warnings).toHaveLength(5);
    expect(parsed.warnings[0]).toContain("filesystem root");
    for (const warning of parsed.warnings.slice(1)) {
      expect(warning).toContain("home directory");
    }
  });
});

describe("per-agent rules", () => {
  it("splits * and agent rules; a bare list is a * rule; invalid scopes are ignored", () => {
    const parsed = parseAssistantMediaRoots(
      "~/Desktop; Work=~/Downloads ; *=~/Downloads;bad id=~/Desktop;notes=~/Desktop:~/missing",
      env,
    );
    expect(parsed.global).toEqual([path.join(home, "Desktop"), path.join(home, "Downloads")]);
    expect(parsed.agents).toEqual({
      work: [path.join(home, "Downloads")],
      notes: [path.join(home, "Desktop")],
    });
    expect(parsed.warnings).toEqual([
      "ignored rule bad id=~/Desktop: bad id is not * or an agent id",
      "ignored ~/missing: does not exist",
    ]);
  });
});

describe("resolveAssistantMediaExtraRoots", () => {
  it("reads the environment on every call", () => {
    expect(resolveAssistantMediaExtraRoots("main", env)).toEqual([]);
    env[ASSISTANT_MEDIA_ROOTS_ENV] = "~/Downloads";
    expect(resolveAssistantMediaExtraRoots("main", env)).toEqual([path.join(home, "Downloads")]);
    env[ASSISTANT_MEDIA_ROOTS_ENV] = "/";
    expect(resolveAssistantMediaExtraRoots("main", env)).toEqual([]);
  });

  it("returns the * folders plus the agent's own, never another agent's", () => {
    env[ASSISTANT_MEDIA_ROOTS_ENV] = "*=~/Desktop;work=~/Downloads:~/Desktop";
    const desktop = path.join(home, "Desktop");
    const downloads = path.join(home, "Downloads");
    expect(resolveAssistantMediaExtraRoots("work", env)).toEqual([desktop, downloads]);
    expect(resolveAssistantMediaExtraRoots("WORK", env)).toEqual([desktop, downloads]);
    expect(resolveAssistantMediaExtraRoots("other", env)).toEqual([desktop]);
    expect(resolveAssistantMediaExtraRoots(undefined, env)).toEqual([desktop]);
  });
});
