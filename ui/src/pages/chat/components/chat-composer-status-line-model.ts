// Fork (F48): pure view model for the one-line session status under the chat composer, like
// Claude Code's status line: model · context % · current turn time · Claude 5h limit · permissions.
import type { GatewaySessionRow } from "../../../api/types.ts";
import type {
  ClaudeUsageTone,
  ClaudeUsageView,
} from "../../../components/claude-usage-indicator-model.ts";
import type { ProviderQuotaGroup } from "../../../lib/provider-quota-summary.ts";
import { getContextNoticeViewModel } from "./chat-composer-context.tsx";

export type ComposerStatusLineInput = {
  session?: GatewaySessionRow;
  runActive?: boolean;
  now: number;
  /** Figures of the sidebar Claude usage indicator (usage.status). */
  claudeUsage?: ClaudeUsageView | null;
  /** Provider plan windows the composer context popover already has (models.authStatus). */
  quotaGroups?: readonly ProviderQuotaGroup[];
  permissionMode?: string | null;
  /** Fork (F49): explicit Claude Code mode of a claude-cli session. */
  claudeMode?: string | null;
};

export type ComposerStatusLineView = {
  model?: string;
  context?: { pct: number; detail: string; approximate: boolean; warning: boolean };
  turnElapsedMs?: number;
  fiveHour?: { percent: number; tone: ClaudeUsageTone; resetAt?: number; reached: boolean };
  permissionMode?: string;
  /** Like Claude Code, the default mode is not announced. */
  claudeMode?: string;
};

const CLAUDE_STATUS_MODES = new Set([
  "acceptEdits",
  "plan",
  "bypassPermissions",
  "dontAsk",
  "auto",
]);

const WARN_PERCENT = 70;
const DANGER_PERCENT = 90;
const CLAUDE_PROVIDER_PATTERN = /anthropic|claude/u;
const CLAUDE_MODEL_PATTERN = /claude|opus|sonnet|haiku/u;

function toneFor(percent: number): ClaudeUsageTone {
  return percent >= DANGER_PERCENT ? "danger" : percent >= WARN_PERCENT ? "warn" : "ok";
}

/** Claude limits apply when the session runs on Claude, or when nothing says otherwise. */
function runsOnClaude(session: GatewaySessionRow | undefined): boolean {
  const provider = session?.modelProvider?.trim().toLowerCase();
  if (provider) {
    return CLAUDE_PROVIDER_PATTERN.test(provider);
  }
  const model = session?.model?.trim().toLowerCase();
  return !model || CLAUDE_MODEL_PATTERN.test(model);
}

function resolveFiveHour(
  input: ComposerStatusLineInput,
): ComposerStatusLineView["fiveHour"] | undefined {
  if (!runsOnClaude(input.session)) {
    return undefined;
  }
  const usage = input.claudeUsage;
  const row = usage?.rows.find((entry) => entry.key.endsWith(":5h"));
  const reached =
    usage?.rateLimit?.status === "rejected" && usage.rateLimit.limitType === "five_hour";
  if (row) {
    return {
      percent: row.percent,
      tone: row.tone,
      ...(row.resetAt !== undefined ? { resetAt: row.resetAt } : {}),
      reached: reached || row.percent >= 100,
    };
  }
  for (const group of input.quotaGroups ?? []) {
    if (!group.providers.some((id) => CLAUDE_PROVIDER_PATTERN.test(id.trim().toLowerCase()))) {
      continue;
    }
    const window = group.windows.find((entry) => entry.label === "5h");
    if (window) {
      return {
        percent: window.usedPercent,
        tone: toneFor(window.usedPercent),
        ...(window.resetAt ? { resetAt: window.resetAt } : {}),
        reached: window.usedPercent >= 100,
      };
    }
  }
  return reached ? { percent: 100, tone: "danger", reached: true } : undefined;
}

function resolveTurnElapsed(input: ComposerStatusLineInput): number | undefined {
  const session = input.session;
  const startedAt = session?.startedAt;
  if (!input.runActive || typeof startedAt !== "number" || !Number.isFinite(startedAt)) {
    return undefined;
  }
  // A recorded end at or after the start belongs to a finished run, not the running one.
  if (typeof session?.endedAt === "number" && session.endedAt >= startedAt) {
    return undefined;
  }
  return Math.max(0, input.now - startedAt);
}

export function resolveComposerStatusLine(input: ComposerStatusLineInput): ComposerStatusLineView {
  const model = input.session?.model?.trim();
  const context = getContextNoticeViewModel(input.session);
  const turnElapsedMs = resolveTurnElapsed(input);
  const fiveHour = resolveFiveHour(input);
  const permissionMode = input.permissionMode?.trim();
  const claudeMode = input.claudeMode?.trim();
  return {
    ...(model ? { model } : {}),
    ...(context
      ? {
          context: {
            pct: context.pct,
            detail: context.detail,
            approximate: context.approximate,
            warning: context.warning,
          },
        }
      : {}),
    ...(turnElapsedMs !== undefined ? { turnElapsedMs } : {}),
    ...(fiveHour ? { fiveHour } : {}),
    ...(permissionMode ? { permissionMode } : {}),
    ...(claudeMode && CLAUDE_STATUS_MODES.has(claudeMode) ? { claudeMode } : {}),
  };
}

export function hasComposerStatusLineParts(view: ComposerStatusLineView): boolean {
  return Boolean(
    view.model ||
    view.context ||
    view.turnElapsedMs !== undefined ||
    view.fiveHour ||
    view.permissionMode ||
    view.claudeMode,
  );
}

/** Compact elapsed time: "8s", "2m 05s", "1h 02m". */
export function formatTurnElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  }
  return `${seconds}s`;
}
