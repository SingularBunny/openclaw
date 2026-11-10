// Fork: extra chat-file folders (`OPENCLAW_ASSISTANT_MEDIA_ROOTS`). Files an assistant attaches
// from these folders open in the Control UI like files inside the agent's media roots (any type,
// not only images), but only for Full Access sessions (`workspaceOnly` false) on this Gateway.
// They never widen agent tool filesystem access: only the assistant media read/inspection route
// adds them to its roots. Read on every use, so a hot `env.vars` change applies to the next read.
//
// Format: rules separated by `;`, each `<scope>=<paths>`. The scope is `*` (every agent) or an
// agent id; a rule without `=` is a `*` rule. Paths are absolute or `~` folders separated by `:`,
// like PATH (Linux and macOS hosts; Windows drive paths cannot be written). A session's folders
// are the `*` folders plus its agent's folders. Relative, missing and
// non-directory entries and invalid agent ids are ignored with a warning; `/`, the home directory
// itself and any folder containing it are refused.
//   ~/Desktop:~/Downloads;work=~/Projects/reports;notes=/srv/shared
import fs from "node:fs";
import path from "node:path";
import { isValidAgentId } from "@openclaw/normalization-core/agent-id";
import { expandHomePrefix, resolveEffectiveHomeDir, resolveOsHomeDir } from "../infra/home-dir.js";
import { isPathInside } from "../infra/path-guards.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

export const ASSISTANT_MEDIA_ROOTS_ENV = "OPENCLAW_ASSISTANT_MEDIA_ROOTS";
/** Path separator inside one rule (PATH style). */
export const ASSISTANT_MEDIA_ROOTS_PATH_SEPARATOR = ":";

const log = createSubsystemLogger("gateway/assistant-media");

export type AssistantMediaRootsParse = {
  /** Folders of every agent (`*` rules and bare path lists). */
  global: string[];
  /** Folders per normalized (lower-case) agent id. */
  agents: Record<string, string[]>;
  warnings: string[];
};

function realpathOrUndefined(value: string): string | undefined {
  try {
    return fs.realpathSync(value);
  } catch {
    return undefined;
  }
}

function homeDirs(env: NodeJS.ProcessEnv): string[] {
  const homes = new Set<string>();
  for (const home of [resolveOsHomeDir(env), resolveEffectiveHomeDir(env)]) {
    if (!home) {
      continue;
    }
    const resolved = path.resolve(home);
    homes.add(resolved);
    const real = realpathOrUndefined(resolved);
    if (real) {
      homes.add(real);
    }
  }
  return [...homes];
}

/** Checks one folder entry; returns its real path or the reason it is skipped. */
function resolveRootEntry(
  entry: string,
  env: NodeJS.ProcessEnv,
  homes: readonly string[],
): { root: string } | { warning: string } {
  const expanded = entry.startsWith("~") ? expandHomePrefix(entry, { env }) : entry;
  if (!path.isAbsolute(expanded)) {
    return { warning: `ignored ${entry}: not an absolute or ~ path` };
  }
  const real = realpathOrUndefined(path.resolve(expanded));
  if (!real) {
    return { warning: `ignored ${entry}: does not exist` };
  }
  let isDirectory: boolean;
  try {
    isDirectory = fs.statSync(real).isDirectory();
  } catch {
    isDirectory = false;
  }
  if (!isDirectory) {
    return { warning: `ignored ${entry}: not a directory` };
  }
  if (real === path.parse(real).root) {
    return { warning: `refused ${entry}: the filesystem root is not allowed` };
  }
  if (homes.some((home) => home === real || isPathInside(real, home))) {
    return {
      warning: `refused ${entry}: the home directory (or a folder containing it) is not allowed`,
    };
  }
  return { root: real };
}

/** Parses the setting into canonical (realpath) directories per scope; never throws. */
export function parseAssistantMediaRoots(
  raw: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): AssistantMediaRootsParse {
  const parsed: AssistantMediaRootsParse = { global: [], agents: {}, warnings: [] };
  const rules = (raw ?? "")
    .split(";")
    .map((rule) => rule.trim())
    .filter(Boolean);
  if (rules.length === 0) {
    return parsed;
  }
  const homes = homeDirs(env);
  for (const rule of rules) {
    const sep = rule.indexOf("=");
    const scope = sep < 0 ? "*" : rule.slice(0, sep).trim();
    if (scope !== "*" && !isValidAgentId(scope)) {
      parsed.warnings.push(`ignored rule ${rule}: ${scope || "(empty)"} is not * or an agent id`);
      continue;
    }
    const target = scope === "*" ? parsed.global : (parsed.agents[scope.toLowerCase()] ??= []);
    const entries = rule
      .slice(sep + 1)
      .split(ASSISTANT_MEDIA_ROOTS_PATH_SEPARATOR)
      .map((entry) => entry.trim())
      .filter(Boolean);
    for (const entry of entries) {
      const resolved = resolveRootEntry(entry, env, homes);
      if ("warning" in resolved) {
        parsed.warnings.push(resolved.warning);
      } else if (!target.includes(resolved.root)) {
        target.push(resolved.root);
      }
    }
  }
  return parsed;
}

const warnedValues = new Set<string>();

/**
 * Current extra roots of one agent from the environment: the `*` folders plus the agent's own.
 * Warns once per distinct value.
 */
export function resolveAssistantMediaExtraRoots(
  agentId: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const raw = env[ASSISTANT_MEDIA_ROOTS_ENV];
  if (!raw?.trim()) {
    return [];
  }
  const parsed = parseAssistantMediaRoots(raw, env);
  if (parsed.warnings.length > 0 && !warnedValues.has(raw)) {
    warnedValues.add(raw);
    for (const warning of parsed.warnings) {
      log.warn(`${ASSISTANT_MEDIA_ROOTS_ENV}: ${warning}`);
    }
  }
  const own = agentId ? (parsed.agents[agentId.trim().toLowerCase()] ?? []) : [];
  return [...new Set([...parsed.global, ...own])];
}
