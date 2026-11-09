import path from "node:path";
import { isPathInside } from "../../infra/path-guards.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { PluginSkillRoot } from "./plugin-skill-root.js";
import type { Skill } from "./skill-contract.js";
import { tryRealpath } from "./symlink-targets.js";

const skillsLogger = createSubsystemLogger("skills");
const reportedQualifications = new Set<string>();

/** Plugin skill names shared across plugins are namespaced as `<pluginId>:<name>`. */
export function qualifyPluginSkillName(pluginId: string, name: string): string {
  return `${pluginId}:${name}`;
}

/**
 * Keeps same-named skills from different plugins available side by side.
 *
 * A name that only one plugin ships stays plain. When several plugins ship it, each copy is
 * renamed to `<pluginId>:<name>`; a single bundled plugin among them keeps the plain name so
 * shipped behavior is unchanged. Other sources (workspace, managed, extra dirs) are untouched
 * and keep their normal precedence over plugin skills.
 */
export function qualifyCollidingPluginSkills<T extends { skill: Skill; syncSourceDir?: string }>(
  entries: readonly T[],
  params: { pluginSkillRoots: readonly PluginSkillRoot[]; pluginSkillsDir?: string },
): T[] {
  const roots = params.pluginSkillRoots.flatMap((root) =>
    root.pluginId
      ? [
          {
            dir: path.resolve(root.dir),
            realPath: tryRealpath(root.dir),
            pluginId: root.pluginId,
            bundled: root.bundled === true,
          },
        ]
      : [],
  );
  if (roots.length === 0) {
    return [...entries];
  }
  const generatedDir = params.pluginSkillsDir ? path.resolve(params.pluginSkillsDir) : undefined;
  const ownerOf = (entry: T) => {
    const discoveryRoot = entry.skill.discoveryRoot?.path;
    if (!discoveryRoot) {
      return undefined;
    }
    const direct = roots.find((root) => root.dir === discoveryRoot);
    if (direct || discoveryRoot !== generatedDir) {
      return direct;
    }
    // Generated links resolve to exactly one declared plugin root.
    const realSkillDir = tryRealpath(entry.syncSourceDir ?? entry.skill.baseDir);
    return realSkillDir
      ? roots.find((root) => root.realPath && isPathInside(root.realPath, realSkillDir))
      : undefined;
  };

  const owners = entries.map(ownerOf);
  const pluginsByName = new Map<string, Map<string, boolean>>();
  entries.forEach((entry, index) => {
    const owner = owners[index];
    if (!owner) {
      return;
    }
    const plugins = pluginsByName.get(entry.skill.name) ?? new Map<string, boolean>();
    plugins.set(owner.pluginId, owner.bundled);
    pluginsByName.set(entry.skill.name, plugins);
  });

  const plainOwner = new Map<string, string | undefined>();
  for (const [name, plugins] of pluginsByName) {
    if (plugins.size < 2) {
      continue;
    }
    const bundled = [...plugins].filter(([, isBundled]) => isBundled).map(([id]) => id);
    const keepsPlain = bundled.length === 1 ? bundled[0] : undefined;
    plainOwner.set(name, keepsPlain);
    reportQualification(name, [...plugins.keys()], keepsPlain);
  }
  if (plainOwner.size === 0) {
    return [...entries];
  }

  return entries.map((entry, index) => {
    const owner = owners[index];
    if (
      !owner ||
      !plainOwner.has(entry.skill.name) ||
      plainOwner.get(entry.skill.name) === owner.pluginId
    ) {
      return entry;
    }
    return {
      ...entry,
      skill: { ...entry.skill, name: qualifyPluginSkillName(owner.pluginId, entry.skill.name) },
    };
  });
}

/** Once per process and distinct plugin set: the outcome is deterministic and not a fault. */
function reportQualification(name: string, pluginIds: string[], keepsPlain: string | undefined) {
  const sorted = pluginIds.toSorted();
  const key = JSON.stringify([name, sorted, keepsPlain]);
  if (reportedQualifications.has(key)) {
    return;
  }
  reportedQualifications.add(key);
  const qualified = sorted
    .filter((id) => id !== keepsPlain)
    .map((id) => qualifyPluginSkillName(id, name));
  skillsLogger.info(
    `plugin skill "${name}" is shipped by ${sorted.join(", ")}; available as ` +
      [...(keepsPlain ? [`${name} (${keepsPlain})`] : []), ...qualified].join(", "),
  );
}

/**
 * Drops a plugin-qualified entry when the same SKILL.md is already visible under its plain
 * name, for example through a project's `skills/<name>` link that picks that plugin's version.
 */
export function dropRedundantQualifiedSkills<T extends { skill: Skill }>(
  entries: T[],
  canonicalize: (filePath: string) => string,
): T[] {
  if (!entries.some((entry) => entry.skill.name.includes(":"))) {
    return entries;
  }
  const plainFiles = new Map<string, string>();
  for (const entry of entries) {
    if (!entry.skill.name.includes(":")) {
      plainFiles.set(entry.skill.name, canonicalize(entry.skill.filePath));
    }
  }
  return entries.filter((entry) => {
    const separator = entry.skill.name.indexOf(":");
    if (separator < 0) {
      return true;
    }
    const plainFile = plainFiles.get(entry.skill.name.slice(separator + 1));
    return plainFile === undefined || plainFile !== canonicalize(entry.skill.filePath);
  });
}
