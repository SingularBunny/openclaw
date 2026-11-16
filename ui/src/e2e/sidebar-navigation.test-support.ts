import { gatewayOriginScope } from "@openclaw/gateway-client/browser";
import type { Page } from "playwright";
import { expect } from "vitest";
import {
  controlUiBundledGatewayUrl,
  controlUiSessionPath,
  waitForControlUiRoute,
} from "../test-helpers/control-ui-e2e.ts";
import { openProgressHomeDock } from "./session-progress-home.test-support.ts";

/** Home can focus its existing page directly or first open the dock on another conversation. */
export async function openHomeFullPage(page: Page, agentId = "main"): Promise<void> {
  const pathname = controlUiSessionPath("agent:" + agentId + ":main");
  const pageAction = page.locator(".assistant-panel").getByRole("button", {
    name: "Open Home full page",
    exact: true,
  });
  if (!(await pageAction.isVisible())) {
    await openProgressHomeDock(page, { waitForSession: false });
  }
  await expect
    .poll(async () => new URL(page.url()).pathname === pathname || (await pageAction.isVisible()))
    .toBe(true);
  // Chip navigation may reach Home before the dock receives its route properties.
  if (new URL(page.url()).pathname === pathname) {
    await waitForControlUiRoute(page, { pathname, routeId: "chat" });
    return;
  }
  if (await pageAction.isVisible()) {
    await pageAction.click();
  }
  await waitForControlUiRoute(page, { pathname, routeId: "chat" });
}

/**
 * Seeds a saved sidebar owner choice (`owner:<id>` or `involving-me`) before the page loads.
 * Without a saved choice the sidebar shows All owners.
 */
export async function storeSidebarSessionOwnerChoice(
  page: Page,
  baseUrl: string,
  profileId: string,
  value: string,
): Promise<void> {
  const key = `openclaw.control.sidebarSessionOwnerFilter.v1:${gatewayOriginScope(
    controlUiBundledGatewayUrl(baseUrl),
  )}:${encodeURIComponent(profileId)}`;
  await page.addInitScript(
    ([storageKey, storedValue]) => {
      // Keep a choice made later in the test across reloads.
      if (localStorage.getItem(storageKey) === null) {
        localStorage.setItem(storageKey, storedValue);
      }
    },
    [key, value] as const,
  );
}

/** Selects All owners explicitly, e.g. after another owner choice. */
export async function selectAllSidebarSessions(page: Page): Promise<void> {
  await page.locator("#sidebar-session-owner-title").click();
  await page.locator('.sidebar-session-owner-filter [role="option"][data-value="all"]').click();
}
