import { createComponent } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import {
  dismissConfirmedActionPopovers,
  isConfirmedActionPopoverFocused,
  RewindButton,
} from "./chat-message-confirmation.ts";

afterEach(() => {
  dismissConfirmedActionPopovers(document.body);
  document.body.replaceChildren();
});

it("tracks focused confirmation ownership through dismissal of another pane", () => {
  const first = document.createElement("section");
  const second = document.createElement("section");
  document.body.append(first, second);
  mountSolid(() => createComponent(RewindButton, { onRewind: () => {} }), { container: first });
  mountSolid(() => createComponent(RewindButton, { onRewind: () => {} }), { container: second });
  first.querySelector<HTMLButtonElement>("button")!.click();
  expect(isConfirmedActionPopoverFocused(first)).toBe(true);
  expect(isConfirmedActionPopoverFocused(second)).toBe(false);
  dismissConfirmedActionPopovers(second);
  expect(isConfirmedActionPopoverFocused(first)).toBe(true);
  dismissConfirmedActionPopovers(first);
  expect(isConfirmedActionPopoverFocused(first)).toBe(false);
  expect(document.querySelector(".chat-confirm-popover")).toBeNull();
});

async function openWithFiles(preview: unknown) {
  const container = document.createElement("section");
  document.body.append(container);
  const onRewind = vi.fn();
  mountSolid(
    () =>
      createComponent(RewindButton, {
        onRewind,
        rewindFiles: async () => preview as never,
      }),
    { container },
  );
  container.querySelector<HTMLButtonElement>("button")!.click();
  await vi.waitFor(() =>
    expect(document.querySelector(".chat-confirm-popover__files-note")?.textContent).not.toBe(
      "Checking files Claude changed…",
    ),
  );
  return { onRewind };
}

it("offers Claude's file restore, checked like Claude Code's own rewind", async () => {
  const { onRewind } = await openWithFiles({
    available: true,
    files: ["/work/src/a.ts", "/work/src/b.ts"],
    insertions: 3,
    deletions: 1,
  });
  const option = document.querySelector<HTMLInputElement>(".chat-confirm-popover__files-check")!;
  expect(option.checked).toBe(true);
  expect(document.querySelector(".chat-confirm-popover__files-option")?.textContent).toBe(
    "Also restore 2 files Claude changed",
  );
  expect(
    [...document.querySelectorAll(".chat-confirm-popover__files-list li")].map(
      (item) => item.textContent,
    ),
  ).toEqual(["a.ts", "b.ts"]);
  document.querySelector<HTMLButtonElement>(".chat-confirm-popover__yes")!.click();
  expect(onRewind).toHaveBeenCalledWith({ restoreFiles: true });
});

it("rewinds the conversation alone when the operator unchecks the files", async () => {
  const { onRewind } = await openWithFiles({ available: true, files: ["/work/a.ts"] });
  document.querySelector<HTMLInputElement>(".chat-confirm-popover__files-check")!.click();
  document.querySelector<HTMLButtonElement>(".chat-confirm-popover__yes")!.click();
  expect(onRewind).toHaveBeenCalledWith({ restoreFiles: false });
});

it("says why files will not be restored", async () => {
  const { onRewind } = await openWithFiles({
    available: false,
    reason: "Files can be restored only in Claude Code (claude-cli) chats.",
  });
  expect(document.querySelector(".chat-confirm-popover__files-check")).toBeNull();
  expect(document.querySelector(".chat-confirm-popover__files-note")?.textContent).toBe(
    "Files will not be restored: Files can be restored only in Claude Code (claude-cli) chats.",
  );
  document.querySelector<HTMLButtonElement>(".chat-confirm-popover__yes")!.click();
  expect(onRewind).toHaveBeenCalledWith({ restoreFiles: false });
});

it("hides the files section when the check is not possible", async () => {
  const container = document.createElement("section");
  document.body.append(container);
  mountSolid(
    () => createComponent(RewindButton, { onRewind: () => {}, rewindFiles: async () => null }),
    { container },
  );
  container.querySelector<HTMLButtonElement>("button")!.click();
  await vi.waitFor(() =>
    expect(document.querySelector<HTMLElement>(".chat-confirm-popover__files")?.hidden).toBe(true),
  );
});
