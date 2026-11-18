import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { t } from "../../i18n/index.ts";
import type { AutomationRowMarker, ChatItem } from "../../lib/chat/chat-types.ts";
import { extractTextCached } from "../../lib/chat/message-extract.ts";

// Fork: scheduler-injected user rows (job prompt, scheduled reminder, repair request)
// render as one compact line instead of a multi-kilobyte operator bubble.

// `[cron:<jobId> <jobName>] <prompt>`: the scheduler's run preamble.
const CRON_PREFIX = /^\[cron:([^\s\]]+)(?: ([^\]\n]*))?\]/u;
const REMINDER_PREFIX = "A scheduled reminder has been triggered. The reminder content is:";
const REPAIR_PREFIX = "Automation repair request from the scheduler, not a user message.";
// A CLI transcript copy of the same prompt lands seconds after the scheduler's row.
const DUPLICATE_WINDOW_MS = 120_000;

type AutomationRow = AutomationRowMarker & { jobName?: string };

const optionalString = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

/**
 * Structured provenance decides first; the known scheduler texts are a fallback only for
 * rows without provenance (CLI transcript copies), and never for owner-sent rows.
 */
export function readAutomationRow(message: unknown): AutomationRow | undefined {
  const raw = asRecord(message);
  if (raw?.role !== "user") {
    return undefined;
  }
  const text = extractTextCached(message)?.trimStart() ?? "";
  const prefix = CRON_PREFIX.exec(text);
  const jobName = optionalString(prefix?.[2]);
  const provenance = asRecord(raw.provenance);
  if (provenance) {
    if (provenance.kind !== "internal_system") {
      return undefined;
    }
    const jobId = optionalString(provenance.jobId);
    if (provenance.sourceTool === "cron") {
      return { kind: "prompt", structured: true, jobId: jobId ?? prefix?.[1], jobName };
    }
    return provenance.sourceTool === "cron_failure_repair"
      ? { kind: "repair", structured: true, jobId }
      : undefined;
  }
  if (asRecord(raw["__openclaw"])?.senderIsOwner === true) {
    return undefined;
  }
  if (prefix) {
    return { kind: "prompt", structured: false, jobId: prefix[1], jobName };
  }
  if (text.startsWith(REMINDER_PREFIX)) {
    return { kind: "reminder", structured: false };
  }
  return text.startsWith(REPAIR_PREFIX) ? { kind: "repair", structured: false } : undefined;
}

function formatClock(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function automationLabel(row: AutomationRow): string {
  return row.kind === "prompt"
    ? row.jobName
      ? t("chat.systemNotice.automationRun.named", { name: row.jobName })
      : t("chat.systemNotice.automationRun.label")
    : row.kind === "reminder"
      ? t("chat.systemNotice.scheduledReminder.label")
      : t("chat.systemNotice.automationRecovery.label");
}

/** One compact line; the full scheduler text stays behind the disclosure. */
export function projectAutomationRow(
  item: Extract<ChatItem, { kind: "message" }>,
  row: AutomationRow,
  timestamp: number,
  boundary: { boundaryId: string } | undefined,
): Extract<ChatItem, { kind: "notice" }> {
  // Repair payloads carry untrusted job text; upstream shows a fixed summary instead.
  const text =
    row.kind === "repair"
      ? t("chat.systemNotice.automationRecovery.summary")
      : (extractTextCached(item.message) ?? "");
  return {
    kind: "notice",
    key: item.key,
    icon: row.kind === "prompt" ? "history" : row.kind === "reminder" ? "bell" : "cpu",
    label: automationLabel(row),
    ...(timestamp > 0 ? { metric: formatClock(timestamp) } : {}),
    startsTurn: true,
    ...(row.kind === "repair" ? {} : { collapsedBody: true }),
    text,
    timestamp,
    automation: { kind: row.kind, structured: row.structured, jobId: row.jobId },
    ...boundary,
  };
}

/**
 * Drops the CLI copy of a prompt the scheduler row already shows, and in the default
 * "details off" mode keeps each automation row as a bare line marking where its run
 * started. Agent replies are untouched; nothing leaves the transcript.
 */
export function applyAutomationRowMode(items: ChatItem[], showDetails: boolean): ChatItem[] {
  const structuredPrompts = items.flatMap((item) =>
    item.kind === "notice" && item.automation?.kind === "prompt" && item.automation.structured
      ? [{ jobId: item.automation.jobId, timestamp: item.timestamp }]
      : [],
  );
  if (!items.some((item) => item.kind === "notice" && item.automation)) {
    return items;
  }
  return items.flatMap((item): ChatItem[] => {
    const automation = item.kind === "notice" ? item.automation : undefined;
    if (item.kind !== "notice" || !automation) {
      return [item];
    }
    const duplicate =
      automation.kind === "prompt" &&
      !automation.structured &&
      structuredPrompts.some(
        (prompt) =>
          prompt.jobId === automation.jobId &&
          Math.abs(prompt.timestamp - item.timestamp) <= DUPLICATE_WINDOW_MS,
      );
    if (duplicate) {
      return [];
    }
    if (showDetails) {
      return [item];
    }
    const { collapsedBody: _collapsed, ...line } = item;
    return [{ ...line, text: "" }];
  });
}
