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
});
