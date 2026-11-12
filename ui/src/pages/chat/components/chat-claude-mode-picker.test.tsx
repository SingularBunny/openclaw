/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../../../api/types.ts";
import { cleanupSolid, mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { ChatClaudeModePicker } from "./chat-claude-mode-picker.tsx";
import { isClaudeCliSessionRow } from "./chat-claude-mode.ts";

afterEach(() => {
  cleanupSolid();
});

const trigger = (container: HTMLElement) =>
  container.querySelector<HTMLButtonElement>("[data-chat-claude-mode-select]")!;
const option = (container: HTMLElement, value: string) =>
  container.querySelector<HTMLButtonElement>(`[data-chat-claude-mode-option="${value}"]`);

async function openMenu(container: HTMLElement) {
  const menu = container.querySelector<HTMLElement>('[role="menu"]')!;
  if (!menu.matches(":popover-open")) {
    trigger(container).dispatchEvent(
      new MouseEvent("click", { detail: 1, bubbles: true, cancelable: true }),
    );
  }
  await waitForSolid(() => expect(menu.matches(":popover-open")).toBe(true));
  return menu;
}

async function selectItem(container: HTMLElement, value: string) {
  await openMenu(container);
  option(container, value)!.click();
  await Promise.resolve();
  flush();
}

describe("ChatClaudeModePicker", () => {
  it("shows the stored mode and lists every Claude Code mode once opened", async () => {
    const onSelect = vi.fn();
    const view = mountSolid(() => (
      <ChatClaudeModePicker mode="plan" canSelectBypass={true} onSelect={onSelect} />
    ));
    flush();
    expect(trigger(view.container).getAttribute("aria-label")).toBe("Claude Code mode: Plan mode");
    expect(trigger(view.container).textContent).toContain("Plan mode");
    // The lazy menu builds its options only once it is opened.
    expect(view.container.querySelector("[data-chat-claude-mode-option]")).toBeNull();

    await openMenu(view.container);
    const options = [
      ...view.container.querySelectorAll<HTMLElement>("[data-chat-claude-mode-option]"),
    ];
    expect(options.map((entry) => entry.dataset.chatClaudeModeOption)).toEqual([
      "unset",
      "default",
      "acceptEdits",
      "plan",
      "bypassPermissions",
      "dontAsk",
      "auto",
    ]);
    expect(options.map((entry) => entry.getAttribute("role"))).toEqual(
      Array(7).fill("menuitemradio"),
    );
    expect(option(view.container, "plan")?.getAttribute("aria-checked")).toBe("true");
    expect(option(view.container, "default")?.getAttribute("aria-checked")).toBe("false");
  });

  it("selects a mode, clears it, and ignores the current one", async () => {
    const onSelect = vi.fn();
    const view = mountSolid(() => (
      <ChatClaudeModePicker mode="plan" canSelectBypass={true} onSelect={onSelect} />
    ));
    flush();
    await selectItem(view.container, "acceptEdits");
    await selectItem(view.container, "unset");
    await selectItem(view.container, "plan");
    expect(onSelect.mock.calls).toEqual([["acceptEdits"], [null]]);
  });

  it("locks bypass permissions without admin access and everything while disabled", async () => {
    const onSelect = vi.fn();
    const view = mountSolid(() => (
      <ChatClaudeModePicker canSelectBypass={false} onSelect={onSelect} />
    ));
    flush();
    await openMenu(view.container);
    expect(option(view.container, "bypassPermissions")?.matches(":disabled")).toBe(true);
    await selectItem(view.container, "bypassPermissions");
    expect(onSelect).not.toHaveBeenCalled();
    expect(trigger(view.container).getAttribute("aria-label")).toBe("Claude Code mode: Not set");

    const disabled = mountSolid(() => (
      <ChatClaudeModePicker canSelectBypass={true} disabled={true} onSelect={onSelect} />
    ));
    flush();
    const disabledTrigger = trigger(disabled.container);
    expect(disabledTrigger.disabled).toBe(true);
    disabledTrigger.click();
    flush();
    expect(
      disabled.container.querySelector<HTMLElement>('[role="menu"]')?.matches(":popover-open"),
    ).toBe(false);
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe("isClaudeCliSessionRow", () => {
  const row = (fields: Partial<GatewaySessionRow>) =>
    ({ key: "agent:main:main", kind: "direct", updatedAt: 1, ...fields }) as GatewaySessionRow;

  it("recognizes the Claude CLI runtime and provider", () => {
    expect(isClaudeCliSessionRow(row({ modelProvider: "claude-cli" }))).toBe(true);
    expect(
      isClaudeCliSessionRow(
        row({ modelProvider: "anthropic", agentRuntime: { id: "claude-cli", source: "model" } }),
      ),
    ).toBe(true);
    expect(
      isClaudeCliSessionRow(
        row({ modelProvider: "anthropic", agentRuntime: { id: "openclaw", source: "model" } }),
      ),
    ).toBe(false);
    expect(isClaudeCliSessionRow(row({ modelProvider: "openai" }))).toBe(false);
    expect(isClaudeCliSessionRow(undefined)).toBe(false);
  });
});
