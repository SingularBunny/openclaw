// Fork: Claude CLI skills whose names contain a colon (plugin:skill) are exposed under a renamed
// folder. Kept out of claude-skills-plugin.ts so upstream changes there merge without conflicts.
import fs from "node:fs/promises";
import path from "node:path";
import { cliBackendLog } from "./log.js";

function withFrontmatterName(content: string, name: string): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(content);
  if (!match) {
    return `---\nname: ${name}\n---\n${content}`;
  }
  const frontmatter = match[1] ?? "";
  const next = /^name:.*$/mu.test(frontmatter)
    ? frontmatter.replace(/^name:.*$/mu, `name: ${name}`)
    : `name: ${name}\n${frontmatter}`;
  return `---\n${next}\n---${content.slice(match[0].length)}`;
}

/**
 * Plugin-qualified OpenClaw names (`<pluginId>:<skill>`) differ from the SKILL.md `name`
 * Claude reads, and two such skills would register the same native name. Give Claude a
 * renamed SKILL.md and link the remaining files unchanged.
 */
type LinkEntry = (params: { sourceDir: string; targetDir: string }) => Promise<void>;

async function materializeRenamedSkillDir(params: {
  sourceDir: string;
  targetDir: string;
  name: string;
  linkEntry: LinkEntry;
}) {
  const linkEntry = params.linkEntry;
  await fs.mkdir(params.targetDir, { mode: 0o700 });
  for (const entry of await fs.readdir(params.sourceDir)) {
    if (entry !== "SKILL.md") {
      await linkEntry({
        sourceDir: path.join(params.sourceDir, entry),
        targetDir: path.join(params.targetDir, entry),
      });
    }
  }
  const content = await fs.readFile(path.join(params.sourceDir, "SKILL.md"), "utf-8");
  await fs.writeFile(
    path.join(params.targetDir, "SKILL.md"),
    withFrontmatterName(content, params.name),
    { encoding: "utf-8", mode: 0o600 },
  );
}

/** Mirrors at most this many entries per level; larger folders are not mirrored. */
const MAX_MIRRORED_ENTRIES = 1000;

async function symlinkEntry(params: { sourceDir: string; targetDir: string }) {
  const stat = await fs.stat(params.sourceDir).catch(() => undefined);
  const type = stat?.isDirectory() ? (process.platform === "win32" ? "junction" : "dir") : "file";
  await fs.symlink(params.sourceDir, params.targetDir, type);
}

async function linkMirrorEntries(params: { sourceDir: string; targetDir: string; skip: string[] }) {
  const entries = (await fs.readdir(params.sourceDir)).filter(
    (entry) => !params.skip.includes(entry),
  );
  if (entries.length > MAX_MIRRORED_ENTRIES) {
    throw new Error(`${params.sourceDir} has more than ${MAX_MIRRORED_ENTRIES} entries`);
  }
  for (const entry of entries) {
    await symlinkEntry({
      sourceDir: path.join(params.sourceDir, entry),
      targetDir: path.join(params.targetDir, entry),
    });
  }
}

/**
 * Skills resolve plugin files relative to their own folder (`../../shared`, `../scripts`,
 * `readlink -f` to the plugin root). A renamed copy is a real temp folder, so build a
 * mirror of the plugin around it: `<mirror>/skills/<name>` holds the renamed SKILL.md, every
 * other entry of the real `skills/` folder and plugin root is a symlink. When the skill does
 * not live in a `skills/` folder, only its parent folder is mirrored. Returns the mirrored
 * skill folder, or `undefined` when the mirror cannot be built with symlinks alone.
 */
async function buildRenamedSkillMirror(params: {
  sourceDir: string;
  mirrorDir: string;
  name: string;
}): Promise<string | undefined> {
  try {
    const realSkillDir = await fs.realpath(params.sourceDir);
    const parentDir = path.dirname(realSkillDir);
    const pluginRoot = path.basename(parentDir) === "skills" ? path.dirname(parentDir) : undefined;
    if (parentDir === realSkillDir) {
      return undefined;
    }
    const mirroredParent = pluginRoot ? path.join(params.mirrorDir, "skills") : params.mirrorDir;
    await fs.mkdir(mirroredParent, { recursive: true, mode: 0o700 });
    if (pluginRoot) {
      await linkMirrorEntries({
        sourceDir: pluginRoot,
        targetDir: params.mirrorDir,
        skip: ["skills"],
      });
    }
    await linkMirrorEntries({
      sourceDir: parentDir,
      targetDir: mirroredParent,
      skip: [params.name],
    });
    const mirroredSkillDir = path.join(mirroredParent, params.name);
    await materializeRenamedSkillDir({
      sourceDir: realSkillDir,
      targetDir: mirroredSkillDir,
      name: params.name,
      linkEntry: symlinkEntry,
    });
    return mirroredSkillDir;
  } catch (error) {
    cliBackendLog.warn(
      `claude skill plugin could not mirror the plugin folder of ${params.sourceDir}: ${error instanceof Error ? error.message : String(error)}`,
    );
    await fs.rm(params.mirrorDir, { recursive: true, force: true }).catch(() => undefined);
    return undefined;
  }
}

/** Links a skill whose name has a colon under a renamed folder; `linkEntry` copies or links other entries. */
export async function linkRenamedSkillDir(params: {
  sourceDir: string;
  targetDir: string;
  mirrorDir: string;
  name: string;
  linkEntry: LinkEntry;
}) {
  const mirroredSkillDir = await buildRenamedSkillMirror(params);
  if (mirroredSkillDir) {
    try {
      await fs.symlink(
        mirroredSkillDir,
        params.targetDir,
        process.platform === "win32" ? "junction" : "dir",
      );
      return;
    } catch {
      await fs.rm(params.mirrorDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
  await materializeRenamedSkillDir(params);
}
