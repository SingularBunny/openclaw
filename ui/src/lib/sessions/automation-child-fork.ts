// Fork: the run session of a job set up from a chat (`automationParentKey` on its row) is not a chat of its own:
// the sidebar never lists it, even with "Show automation sessions" on; its reports reach the parent chat and its
// runs are in the parent chat's Runs tab. Automations the owner sets up keep their own chats.
import { isCronSessionDisplayKey } from "../../../../src/shared/session-list-visibility.ts";

/** Whether an automation row may be listed: other rows always, automation rows when shown and not a child. */
export function sidebarShowsCronRow(
  row: { key: string; automationParentKey?: string },
  showCron: boolean | undefined,
): boolean {
  if (!isCronSessionDisplayKey(row.key)) {
    return true;
  }
  return showCron === true && !row.automationParentKey;
}
