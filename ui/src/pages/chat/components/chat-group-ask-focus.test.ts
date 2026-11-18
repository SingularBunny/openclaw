/* @vitest-environment jsdom */
import { afterEach, expect, it } from "vitest";
import { focusComposerAfterMention } from "./chat-group-ask-focus.ts";

afterEach(() => {
  document.body.replaceChildren();
});

function mountComposer(value: string) {
  const composer = document.body.appendChild(document.createElement("div"));
  const notices = composer.appendChild(document.createElement("div"));
  const chip = notices.appendChild(document.createElement("button"));
  const row = composer.appendChild(document.createElement("div"));
  row.className = "agent-chat__composer-input-row";
  const textarea = row.appendChild(document.createElement("textarea"));
  textarea.value = value;
  return { chip, textarea };
}

it("focuses the composer with the caret after the mention, before the rest of the draft", () => {
  const { chip, textarea } = mountComposer("@Demo Beta please be brief");
  chip.focus();
  focusComposerAfterMention(chip, "@Demo Beta ");
  expect(document.activeElement).toBe(textarea);
  expect(textarea.selectionStart).toBe("@Demo Beta ".length);
  expect(textarea.selectionEnd).toBe("@Demo Beta ".length);
});

it("waits for the draft to show the mention before placing the caret", async () => {
  const { chip, textarea } = mountComposer("");
  focusComposerAfterMention(chip, "@Junie ");
  textarea.value = "@Junie ";
  await new Promise((resolve) => requestAnimationFrame(resolve));
  await new Promise((resolve) => requestAnimationFrame(resolve));
  expect(document.activeElement).toBe(textarea);
  expect(textarea.selectionStart).toBe("@Junie ".length);
});
