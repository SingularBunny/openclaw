// Fork (F49): the one file Claude Code lets a plan-mode session write, its plan.
//
// Claude Code 2.1.302 keeps the plan at `<plans dir>/<slug>.md` (subagents: `<slug>-agent-<id>.md`).
// The plans dir is the `plansDirectory` setting, resolved against the project root and ignored
// unless it stays inside it, else `<CLAUDE_CONFIG_DIR or ~/.claude>/plans`. The slug is chosen
// inside the CLI, so any Markdown file directly in that directory counts as a plan file.
import { lstat, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const PLAN_EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write"]);

function claudeConfigDir(env: Readonly<Record<string, string | undefined>>): string {
  const configured = env.CLAUDE_CONFIG_DIR?.trim();
  if (configured) {
    return path.resolve(configured);
  }
  return path.join(env.HOME?.trim() || os.homedir(), ".claude");
}

async function readPlansDirectorySetting(file: string): Promise<string | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    const value =
      parsed && typeof parsed === "object"
        ? (parsed as { plansDirectory?: unknown }).plansDirectory
        : undefined;
    return typeof value === "string" && value.trim() ? value : undefined;
  } catch {
    return undefined;
  }
}

/** The directory Claude Code writes plan files to for a session started in `cwd`. */
export async function resolveClaudeCliPlansDirectory(params: {
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
}): Promise<string> {
  const configDir = claudeConfigDir(params.env);
  const root = path.resolve(params.cwd);
  // Settings precedence for the user-editable sources: local, then project, then user.
  for (const file of [
    path.join(root, ".claude", "settings.local.json"),
    path.join(root, ".claude", "settings.json"),
    path.join(configDir, "settings.json"),
  ]) {
    const configured = await readPlansDirectorySetting(file);
    if (configured === undefined) {
      continue;
    }
    const resolved = path.resolve(root, configured);
    if (resolved === root || resolved.startsWith(root + path.sep)) {
      return resolved;
    }
    // Like Claude Code: a plans directory outside the project falls back to the default.
    break;
  }
  return path.join(configDir, "plans");
}

/** True when this native edit only writes Claude's plan file, which plan mode allows. */
export async function isClaudeCliPlanFileEdit(params: {
  toolName: string;
  input: Record<string, unknown>;
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
}): Promise<boolean> {
  const filePath = params.input.file_path;
  if (!PLAN_EDIT_TOOLS.has(params.toolName) || typeof filePath !== "string" || !filePath) {
    return false;
  }
  const resolved = path.resolve(params.cwd, filePath);
  if (path.extname(resolved) !== ".md") {
    return false;
  }
  const plansDir = await resolveClaudeCliPlansDirectory(params);
  if (path.dirname(resolved) !== plansDir) {
    return false;
  }
  try {
    // A link in the plans directory could point anywhere.
    return !(await lstat(resolved)).isSymbolicLink();
  } catch (error) {
    // A plan not written yet is still the plan file.
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}
