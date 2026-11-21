import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
// Fork (F51): the composer `/` menu also lists Claude CLI's own commands and skills.
// Kept out of slash-command-catalog.ts so upstream changes there merge without conflicts.
import type {
  ClaudeCommandEntry,
  CommandsClaudeResult,
} from "../../../../packages/gateway-protocol/src/schema/commands.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { t } from "../../i18n/index.ts";
import { registerClaudeComposerEnglish } from "../../i18n/locales/en-claude-composer.ts";
import type { SlashCommandDef } from "./commands.ts";

registerClaudeComposerEnglish();

function claudeCommandCacheKey(agentId: string | undefined, sessionKey?: string): string {
  return JSON.stringify([agentId ?? null, sessionKey ?? null]);
}

// Claude CLI's own commands per session. A list appears after the session's first
// Claude turn, so an empty answer is asked again sooner than a filled one.
const CLAUDE_COMMAND_CACHE_TTL_MS = 30_000;
const CLAUDE_COMMAND_EMPTY_TTL_MS = 10_000;
// A failed read (scope, session access) is not repeated on every `/`.
const CLAUDE_COMMAND_FAILED_TTL_MS = 5 * 60_000;

type ClaudeCommandCacheEntry = {
  entries: ClaudeCommandEntry[];
  expiresAt: number;
  inFlight?: Promise<ClaudeCommandEntry[]>;
};

const claudeCommandCache = new WeakMap<
  GatewayBrowserClient,
  Map<string, ClaudeCommandCacheEntry>
>();

export function loadClaudeSlashCommands(
  client: GatewayBrowserClient,
  agentId: string | undefined,
  sessionKey: string,
): Promise<ClaudeCommandEntry[]> {
  let cache = claudeCommandCache.get(client);
  if (!cache) {
    cache = new Map();
    claudeCommandCache.set(client, cache);
  }
  const key = claudeCommandCacheKey(agentId, sessionKey);
  const cached = cache.get(key);
  if (cached?.inFlight) {
    return cached.inFlight;
  }
  if (cached && cached.expiresAt > Date.now()) {
    return Promise.resolve(cached.entries);
  }
  const entry: ClaudeCommandCacheEntry = {
    entries: cached?.entries ?? [],
    expiresAt: cached?.expiresAt ?? 0,
  };
  const inFlight = client
    .request<CommandsClaudeResult>("commands.claude", {
      sessionKey,
      ...(agentId ? { agentId } : {}),
    })
    .then(
      (result) => {
        const entries = Array.isArray(result?.commands) ? result.commands : [];
        if (cache.get(key) === entry) {
          entry.entries = entries;
          entry.expiresAt =
            Date.now() +
            (entries.length > 0 ? CLAUDE_COMMAND_CACHE_TTL_MS : CLAUDE_COMMAND_EMPTY_TTL_MS);
        }
        return entries;
      },
      () => {
        if (cache.get(key) === entry) {
          entry.expiresAt = Date.now() + CLAUDE_COMMAND_FAILED_TTL_MS;
        }
        return entry.entries;
      },
    )
    .finally(() => {
      if (cache.get(key) === entry) {
        delete entry.inFlight;
      }
    });
  entry.inFlight = inFlight;
  cache.set(key, entry);
  return inFlight;
}

export function invalidateClaudeSlashCommands(
  client: GatewayBrowserClient,
  scope: { agentId: string; sessionKey: string },
): void {
  claudeCommandCache.get(client)?.delete(claudeCommandCacheKey(scope.agentId, scope.sessionKey));
}

const CLAUDE_COMMAND_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u;
const MAX_CLAUDE_COMMANDS = 400;
const MAX_REMOTE_NAME_LENGTH = 200;

/**
 * Appends Claude CLI's own commands and skills after OpenClaw's. A Claude entry whose
 * name an OpenClaw command, alias or skill already uses is dropped: typing it runs OpenClaw's.
 */
export function mergeClaudeSlashCommands(
  base: readonly SlashCommandDef[],
  entries: readonly ClaudeCommandEntry[] | null | undefined,
): SlashCommandDef[] {
  const taken = new Set<string>();
  for (const command of base) {
    for (const name of [command.name, ...(command.aliases ?? [])]) {
      taken.add(normalizeLowercaseStringOrEmpty(name.replace(/^\//u, "")));
    }
  }
  const merged = [...base];
  for (const entry of (entries ?? []).slice(0, MAX_CLAUDE_COMMANDS)) {
    const name = typeof entry?.name === "string" ? entry.name.trim().replace(/^\//u, "") : "";
    const key = normalizeLowercaseStringOrEmpty(name);
    if (
      !name ||
      name.length > MAX_REMOTE_NAME_LENGTH ||
      !CLAUDE_COMMAND_NAME_PATTERN.test(name) ||
      taken.has(key)
    ) {
      continue;
    }
    taken.add(key);
    const kind = entry.kind === "skill" ? "skill" : "command";
    const descriptionKey =
      kind === "skill" ? "chat.commands.claudeSkillDescription" : "chat.commands.claudeDescription";
    merged.push({
      key: `claude:${name}`,
      name,
      description: t(descriptionKey),
      descriptionKey,
      icon: "asterisk",
      category: "tools",
      executeLocal: false,
      tier: "standard",
      source: "claude",
      claudeKind: kind,
    });
  }
  return merged;
}
