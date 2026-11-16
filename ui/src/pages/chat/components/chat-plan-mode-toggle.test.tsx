/* @vitest-environment jsdom */

import { flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { ChatPlanModeToggle } from "./chat-plan-mode-toggle.tsx";

afterEach(() => {
  document.body.replaceChildren();
});

function mount(node: () => unknown) {
  const container = document.body.appendChild(document.createElement("div"));
  mountSolid(node as never, { container });
  flush();
  return container.querySelector<HTMLButtonElement>("[data-chat-plan-mode-toggle]")!;
}

describe("plan mode toggle", () => {
  it("shows plan mode on and turns it off", () => {
    const onToggle = vi.fn();
    const button = mount(() => <ChatPlanModeToggle on known onToggle={onToggle} />);
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(button.dataset.chatPlanMode).toBe("on");
    expect(button.textContent).toContain("Plan");
    button.click();
    expect(onToggle).toHaveBeenCalledWith(false);
  });

  it("shows plan mode off quietly and turns it on", () => {
    const onToggle = vi.fn();
    const button = mount(() => <ChatPlanModeToggle on={false} known onToggle={onToggle} />);
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(button.textContent).toBe("");
    button.click();
    expect(onToggle).toHaveBeenCalledWith(true);
  });

  it("does nothing while a change is pending or without write access", () => {
    const onToggle = vi.fn();
    const pending = mount(() => (
      <ChatPlanModeToggle on={false} known pending onToggle={onToggle} />
    ));
    pending.click();
    document.body.replaceChildren();
    const readOnly = mount(() => (
      <ChatPlanModeToggle on known disabled disabledReason="read only" onToggle={onToggle} />
    ));
    expect(readOnly.title).toBe("read only");
    readOnly.click();
    expect(onToggle).not.toHaveBeenCalled();
  });
});
