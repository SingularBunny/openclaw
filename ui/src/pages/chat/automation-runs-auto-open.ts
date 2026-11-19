// Fork: an automation chat opens with its run history on the right, not the agent's automation list.
const opened = new Set<string>();

/**
 * Opens Runs the first time this page shows the automation chat. Closing Runs is respected:
 * the chat does not reopen it until the page reloads.
 */
export function autoOpenAutomationRuns(sessionKey: string, open: () => void): void {
  if (opened.has(sessionKey)) {
    return;
  }
  opened.add(sessionKey);
  // Header rendering must not change layout synchronously.
  queueMicrotask(open);
}

export function resetAutomationRunsAutoOpenForTest(): void {
  opened.clear();
}
