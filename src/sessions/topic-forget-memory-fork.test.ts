import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectMemoryParagraphs,
  forgetMemoryParagraphs,
  listMemoryFiles,
} from "./topic-forget-memory-fork.js";

const dirs: string[] = [];
async function workspace() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "forget-memory-"));
  dirs.push(dir);
  await fs.mkdir(path.join(dir, "memory"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "MEMORY.md"),
    "# Memory\n\n- [Taxes](memory/taxes.md) — tax deadlines\n- [Weather](memory/weather.md) — likes sun\n",
  );
  await fs.writeFile(
    path.join(dir, "memory", "taxes.md"),
    "# Taxes\n\nThe user files taxes in April.\n",
  );
  await fs.writeFile(
    path.join(dir, "memory", "weather.md"),
    "# Weather\n\nLikes sun.\n\nAsked about tax refunds once.\n",
  );
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("forget a topic in memory files (N11)", () => {
  it("lists the workspace memory and splits it into paragraphs without bare headings", async () => {
    const dir = await workspace();
    const files = await listMemoryFiles({
      workspaceDir: dir,
      extraPaths: [path.join(dir, "none")],
    });
    expect(files.map((file) => path.relative(dir, file)).toSorted()).toEqual([
      "MEMORY.md",
      "memory/taxes.md",
      "memory/weather.md",
    ]);
    const paragraphs = await collectMemoryParagraphs(files);
    expect(paragraphs.map((paragraph) => paragraph.preview)).not.toContain("# Taxes");
    expect(paragraphs.map((paragraph) => paragraph.preview)).toContain(
      "The user files taxes in April.",
    );
  });

  it("removes ticked paragraphs, deletes an emptied file with its index line, keeps a backup", async () => {
    const dir = await workspace();
    const files = await listMemoryFiles({ workspaceDir: dir });
    const paragraphs = await collectMemoryParagraphs(files);
    const pick = (text: string) => paragraphs.find((paragraph) => paragraph.preview === text)!;
    const backupDir = path.join(dir, "..", `${path.basename(dir)}-backup`);
    dirs.push(backupDir);
    const result = await forgetMemoryParagraphs({
      allowedFiles: files,
      picks: [
        pick("The user files taxes in April."),
        pick("Asked about tax refunds once."),
        // Outside the agent's memory: ignored.
        { file: "/etc/hosts", hash: "x" },
      ],
      backupDir,
    });
    expect(result.removed).toBe(2);
    expect(result.deletedFiles.map((file) => path.basename(file))).toEqual(["taxes.md"]);
    await expect(fs.stat(path.join(dir, "memory", "taxes.md"))).rejects.toThrow();
    expect(await fs.readFile(path.join(dir, "memory", "weather.md"), "utf8")).toBe(
      "# Weather\n\nLikes sun.\n",
    );
    const index = await fs.readFile(path.join(dir, "MEMORY.md"), "utf8");
    expect(index).not.toContain("taxes.md");
    expect(index).toContain("weather.md");
    const backup = path.join(backupDir, dir.replace(/^[/\\]+/, ""), "memory", "taxes.md");
    expect(await fs.readFile(backup, "utf8")).toContain("files taxes in April");
  });
});
