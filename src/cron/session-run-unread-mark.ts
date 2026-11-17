/** Keeps a finished automation turn visible in the sidebar when it added no visible reply. */
import { applySessionEntryOperation } from "../config/sessions/session-accessor.sqlite-entry.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("cron/session-run");

export type AutomationRunUnreadFacts = {
  status: "completed" | "failed" | "cancelled";
  executionStarted: boolean;
  replyDisposition?: "visible" | "silent" | "empty";
};

/**
 * A silent or failed automation turn leaves no new visible message, so a chat pane
 * that is still presented would acknowledge its activity at once. A durable unread
 * marker survives that implicit read and clears when the owner opens the chat.
 * Cancelled turns are owner-driven (Stop) and visible replies already announce themselves.
 */
export function shouldMarkAutomationRunUnread(facts: AutomationRunUnreadFacts): boolean {
  if (!facts.executionStarted || facts.status === "cancelled") {
    return false;
  }
  return facts.status === "failed" || facts.replyDisposition !== "visible";
}

export async function markAutomationRunUnread(params: {
  agentId: string;
  sessionKey: string;
  storePath?: string;
  sessionId?: string;
  now?: number;
}): Promise<void> {
  try {
    await applySessionEntryOperation(
      {
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        ...(params.storePath ? { storePath: params.storePath } : {}),
      },
      {
        kind: "fields",
        patch: { markedUnreadAt: params.now ?? Date.now() },
        ...(params.sessionId ? { expected: { sessionId: params.sessionId } } : {}),
      },
      { preserveActivity: true },
    );
  } catch (error) {
    // The run outcome is already settled; a missing mark must not fail the job.
    log.warn("Could not mark the automation session unread", { error: String(error) });
  }
}

/** Isolated runs report ok/error; an abort (Stop or timeout) counts as cancelled. */
export async function markIsolatedCronRunUnread(params: {
  agentId: string;
  sessionKey: string;
  storePath?: string;
  sessionId?: string;
  status: string;
  aborted: boolean;
  replyDisposition?: AutomationRunUnreadFacts["replyDisposition"];
}): Promise<void> {
  const facts: AutomationRunUnreadFacts = {
    status: params.aborted ? "cancelled" : params.status === "ok" ? "completed" : "failed",
    executionStarted: true,
    replyDisposition: params.replyDisposition,
  };
  if (shouldMarkAutomationRunUnread(facts)) {
    await markAutomationRunUnread(params);
  }
}
