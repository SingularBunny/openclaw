// Fork: a chat continued from a session catalog (`plugin:<provider>:catalog-adopt:<kind>:<hash>`)
// without a recorded title reads as the tool it came from, never as its raw key.

const CATALOG_ADOPT_KEY = /^agent:[^:]+:plugin:([^:]+):catalog-adopt:(?:([^:]+):)?[^:]+$/u;

const SOURCE_NAMES: Readonly<Record<string, string>> = {
  claude: "Claude Code chat",
  anthropic: "Claude Code chat",
  pi: "Pi chat",
  opencode: "OpenCode chat",
};

export function catalogAdoptedSessionFallbackName(key: string): string | undefined {
  const match = CATALOG_ADOPT_KEY.exec(key);
  if (!match) {
    return undefined;
  }
  const kind = match[2] ?? match[1] ?? "";
  return SOURCE_NAMES[kind] ?? SOURCE_NAMES[match[1] ?? ""] ?? "Imported chat";
}
