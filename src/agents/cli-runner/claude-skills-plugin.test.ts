import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as tempRootModule from "../../infra/tmp-openclaw-dir.js";
import type { SkillSnapshot } from "../../skills/types.js";
import { createSuiteTempRootTracker } from "../../test-helpers/temp-dir.js";
import { prepareClaudeCliSkillsPlugin } from "./claude-skills-plugin.js";

describe("prepareClaudeCliSkillsPlugin", () => {
  const tempRoot = createSuiteTempRootTracker({ prefix: "openclaw-claude-skills-test-" });
  let base: string;
  let pluginTempRoot: string;
  let skillsSnapshot: SkillSnapshot;

  beforeEach(async () => {
    base = await tempRoot.setup();
    pluginTempRoot = path.join(base, "tmp");
    const skillDir = path.join(base, "source", "demo");
    const skillFile = path.join(skillDir, "SKILL.md");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.mkdir(pluginTempRoot, { recursive: true });
    await fs.writeFile(skillFile, "# Demo\n", "utf8");
    skillsSnapshot = {
      prompt: "demo",
      skills: [{ name: "demo" }],
      resolvedSkills: [
        {
          name: "demo",
          description: "Demo skill",
          filePath: skillFile,
          baseDir: skillDir,
          source: "openclaw-workspace",
          sourceInfo: {
            path: skillFile,
            source: "openclaw-workspace",
            scope: "project",
            origin: "top-level",
            baseDir: skillDir,
          },
          disableModelInvocation: false,
        },
      ],
    };
    vi.spyOn(tempRootModule, "resolvePreferredOpenClawTmpDir").mockReturnValue(pluginTempRoot);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await tempRoot.cleanup();
  });

  it("removes the temporary plugin tree when directory creation fails", async () => {
    const error = Object.assign(new Error("permission denied"), { code: "EACCES" });
    vi.spyOn(fs, "mkdir").mockRejectedValueOnce(error);

    await expect(
      prepareClaudeCliSkillsPlugin({ backendId: "claude-cli", skillsSnapshot }),
    ).rejects.toBe(error);
    await expect(fs.readdir(pluginTempRoot)).resolves.toEqual([]);
  });

  it("removes the temporary plugin tree when the manifest write fails", async () => {
    const error = Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
    vi.spyOn(fs, "writeFile").mockRejectedValueOnce(error);

    await expect(
      prepareClaudeCliSkillsPlugin({ backendId: "claude-cli", skillsSnapshot }),
    ).rejects.toBe(error);
    await expect(fs.readdir(pluginTempRoot)).resolves.toEqual([]);
  });

  it("gives plugin-qualified skills distinct native names", async () => {
    const resolvedSkills: NonNullable<SkillSnapshot["resolvedSkills"]> = [];
    for (const pluginId of ["upkeep", "alpha"]) {
      const skillDir = path.join(base, pluginId, "skills", "review");
      const skillFile = path.join(skillDir, "SKILL.md");
      await fs.mkdir(path.join(skillDir, "references"), { recursive: true });
      await fs.writeFile(
        skillFile,
        `---\nname: review\ndescription: From ${pluginId}\n---\n\n# Method\n`,
        "utf8",
      );
      await fs.writeFile(path.join(skillDir, "references", "notes.md"), pluginId, "utf8");
      resolvedSkills.push({
        ...skillsSnapshot.resolvedSkills![0]!,
        name: `${pluginId}:review`,
        filePath: skillFile,
        baseDir: skillDir,
      });
    }

    const prepared = await prepareClaudeCliSkillsPlugin({
      backendId: "claude-cli",
      skillsSnapshot: { ...skillsSnapshot, resolvedSkills },
    });
    try {
      const skillsDir = path.join(prepared.pluginDir!, "skills");
      expect((await fs.readdir(skillsDir)).toSorted()).toEqual([
        "alpha-review",
        "upkeep-review",
      ]);
      const skillMd = await fs.readFile(
        path.join(skillsDir, "upkeep-review", "SKILL.md"),
        "utf8",
      );
      expect(skillMd).toBe(
        "---\nname: upkeep-review\ndescription: From upkeep\n---\n\n# Method\n",
      );
      await expect(
        fs.readFile(
          path.join(skillsDir, "alpha-review", "references", "notes.md"),
          "utf8",
        ),
      ).resolves.toBe("alpha");
    } finally {
      await prepared.cleanup();
    }
  });
  it("keeps the plugin folders around a renamed skill reachable by relative paths", async () => {
    const pluginRoot = path.join(base, "upkeep-plugin");
    const skillDir = path.join(pluginRoot, "skills", "review");
    await fs.mkdir(path.join(skillDir, "references"), { recursive: true });
    await fs.mkdir(path.join(pluginRoot, "skills", "draft"), { recursive: true });
    await fs.mkdir(path.join(pluginRoot, "shared"), { recursive: true });
    await fs.mkdir(path.join(pluginRoot, "scripts"), { recursive: true });
    await fs.writeFile(path.join(skillDir, "SKILL.md"), "---\nname: review\n---\n", "utf8");
    await fs.writeFile(path.join(skillDir, "references", "notes.md"), "notes", "utf8");
    await fs.writeFile(path.join(pluginRoot, "skills", "draft", "SKILL.md"), "draft", "utf8");
    await fs.writeFile(path.join(pluginRoot, "shared", "x"), "shared", "utf8");
    await fs.writeFile(path.join(pluginRoot, "scripts", "run.sh"), "run", "utf8");
    await fs.writeFile(path.join(pluginRoot, "config.yml"), "config", "utf8");
    // Installed skills are reached through a symlink, as in ~/.openclaw/plugin-skills.
    const linkedSkillDir = path.join(base, "plugin-skills", "review");
    await fs.mkdir(path.dirname(linkedSkillDir), { recursive: true });
    await fs.symlink(skillDir, linkedSkillDir, "dir");

    const prepared = await prepareClaudeCliSkillsPlugin({
      backendId: "claude-cli",
      skillsSnapshot: {
        ...skillsSnapshot,
        resolvedSkills: [
          {
            ...skillsSnapshot.resolvedSkills![0]!,
            name: "upkeep:review",
            filePath: path.join(linkedSkillDir, "SKILL.md"),
            baseDir: linkedSkillDir,
          },
        ],
      },
    });
    try {
      // Unnormalized paths: the OS resolves `..` after following the skill symlink.
      const renamed = `${prepared.pluginDir}/skills/upkeep-review`;
      await expect(fs.readFile(`${renamed}/SKILL.md`, "utf8")).resolves.toBe(
        "---\nname: upkeep-review\n---\n",
      );
      await expect(fs.readFile(`${renamed}/references/notes.md`, "utf8")).resolves.toBe("notes");
      await expect(fs.readFile(`${renamed}/../../shared/x`, "utf8")).resolves.toBe("shared");
      await expect(fs.readFile(`${renamed}/../../scripts/run.sh`, "utf8")).resolves.toBe("run");
      await expect(fs.readFile(`${renamed}/../draft/SKILL.md`, "utf8")).resolves.toBe("draft");
      await expect(fs.readFile(`${renamed}/../review/SKILL.md`, "utf8")).resolves.toBe(
        "---\nname: review\n---\n",
      );

      const mirroredRoot = await fs.realpath(`${renamed}/../..`);
      expect(mirroredRoot.startsWith(await fs.realpath(pluginTempRoot))).toBe(true);
      expect((await fs.readdir(mirroredRoot)).toSorted()).toEqual(
        (await fs.readdir(pluginRoot)).toSorted(),
      );
      expect((await fs.readdir(`${renamed}/..`)).toSorted()).toEqual([
        "draft",
        "review",
        "upkeep-review",
      ]);
      await expect(fs.realpath(`${renamed}/../../shared/x`)).resolves.toBe(
        await fs.realpath(path.join(pluginRoot, "shared", "x")),
      );
    } finally {
      await prepared.cleanup();
    }
    await expect(fs.readdir(pluginTempRoot)).resolves.toEqual([]);
    await expect(fs.readFile(path.join(pluginRoot, "shared", "x"), "utf8")).resolves.toBe("shared");
  });

  it("mirrors the parent folder of a renamed skill outside a skills folder", async () => {
    const skillDir = path.join(base, "loose", "review");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, "SKILL.md"), "# Method\n", "utf8");
    await fs.writeFile(path.join(base, "loose", "helper.sh"), "helper", "utf8");

    const prepared = await prepareClaudeCliSkillsPlugin({
      backendId: "claude-cli",
      skillsSnapshot: {
        ...skillsSnapshot,
        resolvedSkills: [
          {
            ...skillsSnapshot.resolvedSkills![0]!,
            name: "loose:review",
            filePath: path.join(skillDir, "SKILL.md"),
            baseDir: skillDir,
          },
        ],
      },
    });
    try {
      const renamed = `${prepared.pluginDir}/skills/loose-review`;
      await expect(fs.readFile(`${renamed}/SKILL.md`, "utf8")).resolves.toBe(
        "---\nname: loose-review\n---\n# Method\n",
      );
      await expect(fs.readFile(`${renamed}/../helper.sh`, "utf8")).resolves.toBe("helper");
    } finally {
      await prepared.cleanup();
    }
  });
});
