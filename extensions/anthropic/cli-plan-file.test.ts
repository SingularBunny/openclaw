import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveClaudeCliModeGate } from "./cli-permission-mode.js";
import { isClaudeCliPlanFileEdit, resolveClaudeCliPlansDirectory } from "./cli-plan-file.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "openclaw-claude-plan-file-"));
  roots.push(root);
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  await mkdir(home, { recursive: true });
  await mkdir(project, { recursive: true });
  return { home, project, env: { HOME: home } };
}

describe("Claude CLI plans directory", () => {
  it("defaults to ~/.claude/plans and follows CLAUDE_CONFIG_DIR", async () => {
    const { home, project } = await tempRoot();
    await expect(
      resolveClaudeCliPlansDirectory({ cwd: project, env: { HOME: home } }),
    ).resolves.toBe(path.join(home, ".claude", "plans"));
    const configDir = path.join(home, "claude-config");
    await expect(
      resolveClaudeCliPlansDirectory({
        cwd: project,
        env: { HOME: home, CLAUDE_CONFIG_DIR: configDir },
      }),
    ).resolves.toBe(path.join(configDir, "plans"));
  });

  it("uses plansDirectory inside the project and ignores one outside it", async () => {
    const { home, project, env } = await tempRoot();
    await mkdir(path.join(project, ".claude"));
    await writeFile(
      path.join(project, ".claude", "settings.json"),
      JSON.stringify({ plansDirectory: "docs/plans" }),
    );
    await expect(resolveClaudeCliPlansDirectory({ cwd: project, env })).resolves.toBe(
      path.join(project, "docs", "plans"),
    );
    await writeFile(
      path.join(project, ".claude", "settings.local.json"),
      JSON.stringify({ plansDirectory: "../elsewhere" }),
    );
    await expect(resolveClaudeCliPlansDirectory({ cwd: project, env })).resolves.toBe(
      path.join(home, ".claude", "plans"),
    );
  });
});

describe("Claude CLI plan file edits", () => {
  it("allows only Markdown files directly in the plans directory", async () => {
    const { home, project, env } = await tempRoot();
    const plans = path.join(home, ".claude", "plans");
    const check = (toolName: string, filePath: string) =>
      isClaudeCliPlanFileEdit({ toolName, input: { file_path: filePath }, cwd: project, env });

    await expect(check("Write", path.join(plans, "giggly-peacock.md"))).resolves.toBe(true);
    await expect(check("Edit", path.join(plans, "giggly-peacock-agent-a1.md"))).resolves.toBe(true);
    await expect(check("Write", path.join(plans, "notes.txt"))).resolves.toBe(false);
    await expect(check("Write", path.join(plans, "nested", "plan.md"))).resolves.toBe(false);
    await expect(check("Write", path.join(plans, "..", "settings.md"))).resolves.toBe(false);
    await expect(check("Write", path.join(project, "plan.md"))).resolves.toBe(false);
    await expect(check("NotebookEdit", path.join(plans, "plan.md"))).resolves.toBe(false);
  });

  it("refuses a link in the plans directory", async () => {
    const { home, project, env } = await tempRoot();
    const plans = path.join(home, ".claude", "plans");
    await mkdir(plans, { recursive: true });
    await writeFile(path.join(project, "target.md"), "");
    await symlink(path.join(project, "target.md"), path.join(plans, "linked.md"));

    await expect(
      isClaudeCliPlanFileEdit({
        toolName: "Write",
        input: { file_path: path.join(plans, "linked.md") },
        cwd: project,
        env,
      }),
    ).resolves.toBe(false);
  });

  it("lets plan mode write the plan file and nothing else", () => {
    expect(resolveClaudeCliModeGate("plan", "Write", { planFileEdit: true }).kind).toBe("host");
    expect(resolveClaudeCliModeGate("plan", "Write").kind).toBe("deny");
    expect(resolveClaudeCliModeGate("default", "Write", { planFileEdit: true }).kind).toBe("ask");
  });
});
