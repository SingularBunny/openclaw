import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../../../api/types.ts";
import { cleanupSolid, mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush } from "../../../test-helpers/solid-settle.ts";
import { ChatClaudeModePicker } from "./chat-claude-mode-picker.tsx";
import { isClaudeCliSessionRow } from "./chat-claude-mode.ts";

afterEach(() => {
  cleanupSolid();
});

function selectItem(container: HTMLElement, value: string) {
  container
    .querySelector("wa-dropdown")!
    .dispatchEvent(new CustomEvent("wa-select", { detail: { item: { value } } }));
}

describe("ChatClaudeModePicker", () => {
  it("shows the stored mode and lists every Claude Code mode once opened", () => {
    const onSelect = vi.fn();
    const view = mountSolid(() => (
      <ChatClaudeModePicker mode="plan" canSelectBypass={true} onSelect={onSelect} />
    ));
    const trigger = view.container.querySelector<HTMLElement>("[data-chat-claude-mode-select]");
    expect(trigger?.getAttribute("aria-label")).toBe("Claude Code mode: Plan mode");
    expect(trigger?.textContent).toContain("Plan mode");
    expect(view.container.querySelector("wa-dropdown-item")).toBeNull();

    view.container.querySelector("wa-dropdown")!.dispatchEvent(new Event("wa-show"));
    flush();
    const options = [
      ...view.container.querySelectorAll<HTMLElement>("[data-chat-claude-mode-option]"),
    ];
    expect(options.map((option) => option.dataset.chatClaudeModeOption)).toEqual([
      "unset",
      "default",
      "acceptEdits",
      "plan",
      "bypassPermissions",
      "dontAsk",
      "auto",
    ]);
    expect(
      view.container
        .querySelector('[data-chat-claude-mode-option="plan"]')
        ?.getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("selects a mode, clears it, and ignores the current one", () => {
    const onSelect = vi.fn();
    const view = mountSolid(() => (
      <ChatClaudeModePicker mode="plan" canSelectBypass={true} onSelect={onSelect} />
    ));
    selectItem(view.container, "acceptEdits");
    selectItem(view.container, "unset");
    selectItem(view.container, "plan");
    selectItem(view.container, "bogus");
    expect(onSelect.mock.calls).toEqual([["acceptEdits"], [null]]);
  });

  it("locks bypass permissions without admin access and everything while disabled", () => {
    const onSelect = vi.fn();
    const view = mountSolid(() => (
      <ChatClaudeModePicker canSelectBypass={false} onSelect={onSelect} />
    ));
    view.container.querySelector("wa-dropdown")!.dispatchEvent(new Event("wa-show"));
    flush();
    expect(
      view.container
        .querySelector('[data-chat-claude-mode-option="bypassPermissions"]')
        ?.hasAttribute("disabled"),
    ).toBe(true);
    selectItem(view.container, "bypassPermissions");
    expect(onSelect).not.toHaveBeenCalled();
    expect(
      view.container.querySelector("[data-chat-claude-mode-select]")?.getAttribute("aria-label"),
    ).toBe("Claude Code mode: Not set");

    const disabled = mountSolid(() => (
      <ChatClaudeModePicker canSelectBypass={true} disabled={true} onSelect={onSelect} />
    ));
    selectItem(disabled.container, "plan");
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
