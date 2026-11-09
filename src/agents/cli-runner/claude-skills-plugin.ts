import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { resolvePreferredOpenClawTmpDir } from "../../infra/tmp-openclaw-dir.js";
import { ensureWritableSkillDirectories } from "../../skills/loading/skill-directory-modes.js";
import type { SkillSnapshot } from "../../skills/types.js";
import { cliBackendLog } from "./log.js";

const CLAUDE_CLI_BACKEND_ID = "claude-cli";
const OPENCLAW_CLAUDE_PLUGIN_NAME = "openclaw-skills";

function sanitizeSkillDirName(name: string, used: Set<string>): string {
  const base =
    name
      .trim()
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "skill";
  const safeBase = base.startsWith(".") ? `skill-${base.replace(/^\.+/, "") || "skill"}` : base;
  let candidate = safeBase;
  for (let index = 2; used.has(candidate); index += 1) {
    candidate = `${safeBase}-${index}`;
  }
  used.add(candidate);
  return candidate;
}

async function linkOrCopySkillDir(params: { sourceDir: string; targetDir: string }) {
  try {
    await fs.symlink(
      params.sourceDir,
      params.targetDir,
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch {
    // Symlinks are preferred to avoid copying skill trees, but Windows/TCC/filesystem policy can
    // reject them. Copying preserves the session-scoped plugin contract.
    await fs.cp(params.sourceDir, params.targetDir, {
      recursive: true,
      force: true,
      verbatimSymlinks: true,
    });
    await ensureWritableSkillDirectories(
      path.dirname(params.targetDir),
      path.basename(params.targetDir),
    );
  }
}

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
async function materializeRenamedSkillDir(params: {
  sourceDir: string;
  targetDir: string;
  name: string;
}) {
  await fs.mkdir(params.targetDir, { mode: 0o700 });
  for (const entry of await fs.readdir(params.sourceDir)) {
    if (entry !== "SKILL.md") {
      await linkOrCopySkillDir({
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

/** Prepares Claude CLI `--plugin-dir` args for the current session skill snapshot. */
export async function prepareClaudeCliSkillsPlugin(params: {
  backendId: string;
  skillsSnapshot?: SkillSnapshot;
}): Promise<{ args: string[]; cleanup: () => Promise<void>; pluginDir?: string }> {
  if (normalizeLowercaseStringOrEmpty(params.backendId) !== CLAUDE_CLI_BACKEND_ID) {
    return { args: [], cleanup: async () => {} };
  }
  // Library command identities are host-owned, not frontmatter names. Keep their
  // canonical catalog and immutable paths instead of registering colliding native aliases.
  if (params.skillsSnapshot?.librarySelections?.length) {
    return { args: [], cleanup: async () => {} };
  }

  const usedTargetNames = new Set<string>();
  const skills = (params.skillsSnapshot?.resolvedSkills ?? []).flatMap((skill) => {
    const name = skill.name?.trim();
    const skillFilePath = skill.filePath?.trim();
    if (!name || !skillFilePath) {
      return [];
    }
    if (!existsSync(skillFilePath)) {
      cliBackendLog.warn(`claude skill plugin skipped missing skill file: ${skillFilePath}`);
      return [];
    }
    return [
      {
        name,
        sourceDir: path.dirname(skillFilePath),
        targetDirName: sanitizeSkillDirName(name, usedTargetNames),
      },
    ];
  });
  if (skills.length === 0) {
    return { args: [], cleanup: async () => {} };
  }

  const tempDir = await fs.mkdtemp(
    path.join(resolvePreferredOpenClawTmpDir(), "openclaw-claude-skills-"),
  );
  const cleanup = () => fs.rm(tempDir, { recursive: true, force: true });
  const pluginDir = path.join(tempDir, OPENCLAW_CLAUDE_PLUGIN_NAME);
  const manifestDir = path.join(pluginDir, ".claude-plugin");
  const skillsDir = path.join(pluginDir, "skills");
  try {
    await fs.mkdir(manifestDir, { recursive: true, mode: 0o700 });
    await fs.mkdir(skillsDir, { recursive: true, mode: 0o700 });

    const manifest = {
      name: OPENCLAW_CLAUDE_PLUGIN_NAME,
      version: "0.0.0",
      description: "Session-scoped OpenClaw skills selected for this agent run.",
      skills: "./skills",
    };
    await fs.writeFile(
      path.join(manifestDir, "plugin.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      {
        encoding: "utf-8",
        mode: 0o600,
      },
    );

    let linkedSkillCount = 0;
    for (const skill of skills) {
      try {
        const targetDir = path.join(skillsDir, skill.targetDirName);
        if (skill.name.includes(":")) {
          await materializeRenamedSkillDir({
            sourceDir: skill.sourceDir,
            targetDir,
            name: skill.targetDirName,
          });
        } else {
          await linkOrCopySkillDir({ sourceDir: skill.sourceDir, targetDir });
        }
        linkedSkillCount += 1;
      } catch (error) {
        cliBackendLog.warn(
          `claude skill plugin skipped ${skill.name}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    if (linkedSkillCount === 0) {
      await cleanup();
      return { args: [], cleanup: async () => {} };
    }

    return {
      args: ["--plugin-dir", pluginDir],
      pluginDir,
      cleanup,
    };
  } catch (error) {
    await cleanup().catch(() => undefined);
    throw error;
  }
}
