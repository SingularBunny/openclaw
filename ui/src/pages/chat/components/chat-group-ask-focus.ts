// Fork: after **Ask <name>** the composer takes focus with the caret after "@name ", so the
// next keystrokes land after the mention instead of before it.

const COMPOSER_TEXTAREA = ".agent-chat__composer-input-row textarea";
const MAX_FRAMES = 6;

/** The chat composer's textarea nearest to `from` (the Ask chip sits in the composer's notices). */
export function findComposerTextarea(from: Element): HTMLTextAreaElement | null {
  for (let node: Element | null = from; node; node = node.parentElement) {
    const textarea = node.querySelector<HTMLTextAreaElement>(COMPOSER_TEXTAREA);
    if (textarea) {
      return textarea;
    }
  }
  return null;
}

/** Focuses the composer once its draft starts with `mention`, caret right after it. */
export function focusComposerAfterMention(from: Element, mention: string): void {
  const view = from.ownerDocument.defaultView;
  let frames = 0;
  const attempt = () => {
    const textarea = findComposerTextarea(from);
    if (!textarea) {
      return;
    }
    if (!textarea.value.startsWith(mention) && frames++ < MAX_FRAMES && view) {
      view.requestAnimationFrame(attempt);
      return;
    }
    const caret = textarea.value.startsWith(mention) ? mention.length : textarea.value.length;
    textarea.focus({ preventScroll: true });
    textarea.setSelectionRange(caret, caret);
  };
  attempt();
}
