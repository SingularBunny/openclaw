// Fork (F51): Claude CLI's own slash commands and skills from its `system/init` record, kept
// per OpenClaw session so the Control UI can offer them in the `/` autocomplete.
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

export type ClaudeNativeCommandKind = "command" | "skill";

export type ClaudeNativeCommand = {
  /** Name without the leading slash, as Claude CLI accepts it (`review`, `plugin:skill`). */
  name: string;
  kind: ClaudeNativeCommandKind;
};

export type ClaudeNativeCommandSnapshot = {
  commands: ClaudeNativeCommand[];
  capturedAt: number;
};

export const CLAUDE_NATIVE_COMMANDS_MAX = 400;
export const CLAUDE_NATIVE_COMMAND_NAME_MAX_LENGTH = 200;
// Memory bound only; a session that has not run for a while re-reports its list on the next turn.
const MAX_SESSIONS = 512;
const MAX_AGENTS = 64;

// Claude command names: built-ins (`compact`), custom commands (`frontend:review`), plugin
// skills (`plugin:skill`). Anything else (spaces, slashes, control characters) is dropped.
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u;

type ClaudeNativeCommandState = {
  bySessionId: Map<string, ClaudeNativeCommandSnapshot>;
  byAgentId: Map<string, ClaudeNativeCommandSnapshot>;
};

const state = resolveGlobalSingleton<ClaudeNativeCommandState>(
  Symbol.for("openclaw.claudeNativeCommands.state"),
  () => ({ bySessionId: new Map(), byAgentId: new Map() }),
);

function readNames(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const names: string[] = [];
  for (const item of value) {
    const raw =
      typeof item === "string"
        ? item
        : item && typeof item === "object" && typeof (item as { name?: unknown }).name === "string"
          ? (item as { name: string }).name
          : undefined;
    const name = raw?.trim().replace(/^\//u, "");
    if (name && name.length <= CLAUDE_NATIVE_COMMAND_NAME_MAX_LENGTH && NAME_PATTERN.test(name)) {
      names.push(name);
    }
  }
  return names;
}

/**
 * Reads `slash_commands` and `skills` from a Claude CLI `system/init` record. Returns undefined
 * when the record carries neither list (older CLI builds), so a cached list is not cleared.
 */
export function readClaudeInitCommands(
  record: Record<string, unknown>,
): ClaudeNativeCommand[] | undefined {
  if (!Array.isArray(record.slash_commands) && !Array.isArray(record.skills)) {
    return undefined;
  }
  const skills = readNames(record.skills);
  const skillKeys = new Set(skills.map((name) => name.toLowerCase()));
  const seen = new Set<string>();
  const commands: ClaudeNativeCommand[] = [];
  for (const name of [...readNames(record.slash_commands), ...skills]) {
    const key = name.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    commands.push({ name, kind: skillKeys.has(key) ? "skill" : "command" });
    if (commands.length >= CLAUDE_NATIVE_COMMANDS_MAX) {
      break;
    }
  }
  return commands;
}

function remember(
  map: Map<string, ClaudeNativeCommandSnapshot>,
  key: string,
  value: ClaudeNativeCommandSnapshot,
  max: number,
) {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    map.delete(oldest);
  }
}

/** Keeps the latest Claude command list for the OpenClaw session and its agent. */
export function recordClaudeNativeCommands(params: {
  sessionId: string;
  agentId?: string;
  commands: readonly ClaudeNativeCommand[];
  now?: number;
}): boolean {
  const sessionId = params.sessionId.trim();
  if (!sessionId || params.commands.length === 0) {
    return false;
  }
  const snapshot: ClaudeNativeCommandSnapshot = {
    commands: params.commands.slice(0, CLAUDE_NATIVE_COMMANDS_MAX).map((command) => ({
      name: command.name,
      kind: command.kind,
    })),
    capturedAt: params.now ?? Date.now(),
  };
  remember(state.bySessionId, sessionId, snapshot, MAX_SESSIONS);
  const agentId = params.agentId?.trim();
  if (agentId) {
    remember(state.byAgentId, agentId, snapshot, MAX_AGENTS);
  }
  return true;
}

/**
 * The session's own list, else (when allowed) the latest list another session of the same agent
 * reported: Claude's commands and skills come from the user's and the project's Claude setup,
 * so a fresh session usually has the same ones before its first turn.
 */
export function readClaudeNativeCommands(params: {
  sessionId?: string;
  agentId?: string;
  agentFallback?: boolean;
}): (ClaudeNativeCommandSnapshot & { fromAgent?: true }) | undefined {
  const sessionId = params.sessionId?.trim();
  const own = sessionId ? state.bySessionId.get(sessionId) : undefined;
  if (own) {
    return own;
  }
  const agentId = params.agentId?.trim();
  const shared = params.agentFallback && agentId ? state.byAgentId.get(agentId) : undefined;
  return shared ? { ...shared, fromAgent: true } : undefined;
}

export function resetClaudeNativeCommandsForTest(): void {
  state.bySessionId.clear();
  state.byAgentId.clear();
}
