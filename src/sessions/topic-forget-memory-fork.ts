// Fork (N11): forget a topic in the agent's memory files too. Memory search indexes the agent
// workspace's MEMORY.md and memory/**/*.md plus `memorySearch.extraPaths` (shared memory); a
// forgotten chat turn would come back through them. Their paragraphs are ranked like chat turns;
// ticked paragraphs are removed. A file left without content is deleted together with the
// MEMORY.md index line that links it. The previous file goes to a backup folder outside every
// memory root, so memory search does not find it again.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export type MemoryParagraph = {
  id: string;
  file: string;
  hash: string;
  text: string;
  preview: string;
};

const PARAGRAPH_LIMIT = 2_000;
const MAX_PARAGRAPHS = 3_000;
const MAX_FILES = 2_000;

const hashText = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

/** Paragraphs separated by blank lines; a bare heading is not a fact to forget. */
export function splitMemoryParagraphs(text: string): string[] {
  return text.split(/\n\s*\n/).filter((block) => block.trim().length > 0);
}

function isContent(block: string): boolean {
  return block
    .split("\n")
    .some((line) => line.trim().length > 0 && !/^\s*(#{1,6}\s|---\s*$)/.test(line));
}

async function listMarkdown(dir: string, out: string[]): Promise<void> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= MAX_FILES) {
      return;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && !entry.name.startsWith(".")) {
      await listMarkdown(full, out);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      out.push(full);
    }
  }
}

/** The memory files of an agent: workspace MEMORY.md, memory/**, and the extra memory paths. */
export async function listMemoryFiles(roots: {
  workspaceDir?: string;
  extraPaths?: readonly string[];
}): Promise<string[]> {
  const files: string[] = [];
  const addRoot = async (root: string) => {
    const stat = await fs.stat(root).catch(() => undefined);
    if (stat?.isFile()) {
      if (root.endsWith(".md")) {
        files.push(root);
      }
      return;
    }
    if (!stat?.isDirectory()) {
      return;
    }
    const index = path.join(root, "MEMORY.md");
    if (
      await fs.stat(index).then(
        (s) => s.isFile(),
        () => false,
      )
    ) {
      files.push(index);
    }
    await listMarkdown(path.join(root, "memory"), files);
  };
  if (roots.workspaceDir) {
    await addRoot(roots.workspaceDir);
  }
  for (const extra of roots.extraPaths ?? []) {
    await addRoot(extra);
  }
  return [...new Set(files.map((file) => path.resolve(file)))];
}

export async function collectMemoryParagraphs(
  files: readonly string[],
): Promise<MemoryParagraph[]> {
  const out: MemoryParagraph[] = [];
  for (const file of files) {
    const text = await fs.readFile(file, "utf8").catch(() => "");
    for (const block of splitMemoryParagraphs(text)) {
      if (out.length >= MAX_PARAGRAPHS) {
        return out;
      }
      if (!isContent(block)) {
        continue;
      }
      const hash = hashText(block);
      out.push({
        id: `memory:${file}#${hash}`,
        file,
        hash,
        text: block.slice(0, PARAGRAPH_LIMIT),
        preview: block.replace(/\s+/g, " ").trim().slice(0, 240),
      });
    }
  }
  return out;
}

/** Index lines of MEMORY.md that link a removed file (`(memory/x.md)` or `[[x]]`). */
function dropIndexLines(index: string, removed: string): string {
  const base = path.basename(removed, ".md");
  const link = new RegExp(
    `\\]\\((?:\\./)?memory/${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.md\\)|\\[\\[${base.replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&",
    )}\\]\\]`,
  );
  return index
    .split("\n")
    .filter((line) => !link.test(line))
    .join("\n");
}

async function writeAtomic(file: string, text: string): Promise<void> {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, text, "utf8");
  await fs.rename(tmp, file);
}

async function backup(file: string, backupDir: string): Promise<void> {
  const target = path.join(backupDir, file.replace(/^[/\\]+/, "").replace(/[:\\]/g, "_"));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(file, target);
}

/**
 * Removes the chosen paragraphs (by file and hash) from files inside `allowedFiles` only.
 * Returns the number of paragraphs removed and the files deleted.
 */
export async function forgetMemoryParagraphs(params: {
  allowedFiles: readonly string[];
  picks: readonly { file: string; hash: string }[];
  backupDir: string;
}): Promise<{ removed: number; deletedFiles: string[] }> {
  const allowed = new Set(params.allowedFiles.map((file) => path.resolve(file)));
  const byFile = new Map<string, Set<string>>();
  for (const pick of params.picks) {
    const file = path.resolve(pick.file);
    if (!allowed.has(file)) {
      continue;
    }
    byFile.set(file, (byFile.get(file) ?? new Set()).add(pick.hash));
  }
  let removed = 0;
  const deletedFiles: string[] = [];
  for (const [file, hashes] of byFile) {
    const text = await fs.readFile(file, "utf8").catch(() => undefined);
    if (text === undefined) {
      continue;
    }
    const blocks = splitMemoryParagraphs(text);
    const kept = blocks.filter((block) => !hashes.has(hashText(block)));
    if (kept.length === blocks.length) {
      continue;
    }
    await backup(file, params.backupDir);
    removed += blocks.length - kept.length;
    const isIndex = path.basename(file) === "MEMORY.md";
    if (!isIndex && !kept.some(isContent)) {
      await fs.rm(file, { force: true });
      deletedFiles.push(file);
      continue;
    }
    await writeAtomic(file, `${kept.join("\n\n").trimEnd()}\n`);
  }
  // A deleted memory file leaves no dangling link in its root's MEMORY.md.
  for (const deleted of deletedFiles) {
    const root = path.dirname(path.dirname(deleted));
    const index = path.join(root, "MEMORY.md");
    if (!allowed.has(index)) {
      continue;
    }
    const text = await fs.readFile(index, "utf8").catch(() => undefined);
    if (text === undefined) {
      continue;
    }
    const next = dropIndexLines(text, deleted);
    if (next !== text) {
      await backup(index, params.backupDir);
      await writeAtomic(index, next);
    }
  }
  return { removed, deletedFiles };
}
