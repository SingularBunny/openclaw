/**
 * Reads account usage out of an ACP agent's reply to its usage slash command
 * (for example `/stats`). The reply is free-form markdown; this parser keeps to
 * `key: value` lines so it does not depend on any one agent's layout.
 */

export type AcpUsageReply =
  | {
      kind: "usage";
      balance?: { label: string; amount: number; unit: string };
      plan?: string;
    }
  | { kind: "logged-out" }
  | { kind: "error"; message: string };

const BALANCE_KEYS = new Set([
  "balance",
  "balance left",
  "remaining balance",
  "credit balance",
  "credits",
  "credits left",
  "remaining credits",
]);
const PLAN_KEYS = new Set(["license", "licence", "plan", "subscription", "tier"]);
const LOGGED_OUT =
  /\b(not (logged|signed) in|log ?in required|authentication required|please (log|sign) in|unauthenticated)\b/i;
const MAX_MESSAGE_CHARS = 160;

/** Drops markdown list markers, emphasis and code ticks around a line. */
function plainLine(line: string): string {
  return line
    .replace(/^\s*(?:[-*+•]|\d+[.)])\s+/, "")
    .replace(/\*\*|__|`/g, "")
    .replace(/^#+\s*/, "")
    .trim();
}

/** Parses `1,234.50`, `1 234,5` or `36.01`; the last separator with 1-2 digits after it is decimal. */
export function parseUsageAmount(raw: string): number | undefined {
  const text = raw.replace(/[\s  ]/g, "");
  if (!/^[-+]?\d[\d.,]*$/.test(text)) {
    return undefined;
  }
  const lastSep = Math.max(text.lastIndexOf("."), text.lastIndexOf(","));
  const decimals = lastSep >= 0 ? text.length - lastSep - 1 : 0;
  const normalized =
    lastSep >= 0 && decimals > 0 && decimals <= 2
      ? `${text.slice(0, lastSep).replace(/[.,]/g, "")}.${text.slice(lastSep + 1)}`
      : text.replace(/[.,]/g, "");
  const value = Number(normalized);
  return Number.isFinite(value) ? value : undefined;
}

function parseBalance(label: string, value: string) {
  const match = /^([-+]?[\d][\d\s  .,]*)\s*(.*)$/.exec(value);
  if (!match) {
    return undefined;
  }
  const amount = parseUsageAmount(match[1] ?? "");
  if (amount === undefined) {
    return undefined;
  }
  const unit =
    (match[2] ?? "")
      .replace(/[.;,]+$/, "")
      .replace(/\(.*\)$/, "")
      .trim() || "credits";
  return { label, amount, unit };
}

function truncate(text: string): string {
  return text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS - 1)}…` : text;
}

/** Classifies one usage reply: balance and plan, a logged-out notice, or the agent's error text. */
export function parseAcpUsageReply(text: string): AcpUsageReply {
  const lines = text
    .split(/\r?\n/)
    .map(plainLine)
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    return { kind: "error", message: "The agent sent an empty reply" };
  }
  let balance: { label: string; amount: number; unit: string } | undefined;
  let plan: string | undefined;
  let keyValueLines = 0;
  for (const line of lines) {
    const match = /^([^:]{1,40}):\s*(.+)$/.exec(line);
    if (!match) {
      continue;
    }
    keyValueLines += 1;
    const label = (match[1] ?? "").trim();
    const value = (match[2] ?? "").trim();
    const key = label.toLowerCase().replace(/\s+/g, " ");
    if (!balance && BALANCE_KEYS.has(key)) {
      balance = parseBalance(label, value);
    } else if (!plan && PLAN_KEYS.has(key)) {
      plan = truncate(value);
    }
  }
  if (balance || plan) {
    return { kind: "usage", ...(balance ? { balance } : {}), ...(plan ? { plan } : {}) };
  }
  if (LOGGED_OUT.test(text)) {
    return { kind: "logged-out" };
  }
  if (keyValueLines >= 2) {
    // Statistics without an account section: own API keys, nothing to show as a balance.
    // A single `Error: ...` line stays an error.
    return { kind: "usage" };
  }
  return { kind: "error", message: truncate(lines[0] ?? "") };
}
