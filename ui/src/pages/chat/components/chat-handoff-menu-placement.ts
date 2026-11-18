// Fork (F76): the Hand off menu opens in the top layer, above or below its button, whichever
// side fits, clamped to the window. Under the first reply of a short chat it used to open
// upward behind the chat header.

export type HandoffMenuRect = { top: number; bottom: number; left: number; right: number };

export type HandoffMenuPlacement = {
  side: "above" | "below";
  top: number;
  left: number;
  maxHeight: number;
};

const GAP = 4;
const MARGIN = 8;
const PREFERRED_MAX_HEIGHT = 320;

/** Above when the menu fits there (the old default), else the roomier side; never off-screen. */
export function resolveHandoffMenuPlacement(
  trigger: HandoffMenuRect,
  viewport: { width: number; height: number },
  menu: { width: number; height: number },
): HandoffMenuPlacement {
  const wanted = Math.min(menu.height, PREFERRED_MAX_HEIGHT);
  const above = trigger.top - GAP - MARGIN;
  const below = viewport.height - trigger.bottom - GAP - MARGIN;
  const side = above >= wanted || above >= below ? "above" : "below";
  const maxHeight = Math.max(0, Math.min(PREFERRED_MAX_HEIGHT, side === "above" ? above : below));
  const height = Math.min(wanted, maxHeight);
  const top = side === "above" ? trigger.top - GAP - height : trigger.bottom + GAP;
  const left = Math.max(MARGIN, Math.min(trigger.left, viewport.width - MARGIN - menu.width));
  return { side, top, left, maxHeight };
}

/** Moves the open menu into the top layer and places it next to its button. */
export function placeHandoffMenu(trigger: HTMLElement, menu: HTMLElement): void {
  if (!menu.isConnected) {
    return;
  }
  if (typeof menu.showPopover === "function" && !menu.matches(":popover-open")) {
    menu.setAttribute("popover", "manual");
    menu.showPopover();
  }
  const view = menu.ownerDocument.defaultView;
  const placement = resolveHandoffMenuPlacement(
    trigger.getBoundingClientRect(),
    { width: view?.innerWidth ?? 0, height: view?.innerHeight ?? 0 },
    { width: menu.offsetWidth, height: menu.scrollHeight },
  );
  menu.dataset.side = placement.side;
  Object.assign(menu.style, {
    position: "fixed",
    inset: "auto",
    margin: "0",
    top: `${placement.top}px`,
    left: `${placement.left}px`,
    maxHeight: `${placement.maxHeight}px`,
  });
}

/** Keeps the menu next to its button while the chat scrolls or the window resizes. */
export function followHandoffMenu(trigger: HTMLElement, menu: HTMLElement): () => void {
  const view = menu.ownerDocument.defaultView;
  const place = () => placeHandoffMenu(trigger, menu);
  place();
  view?.addEventListener("scroll", place, true);
  view?.addEventListener("resize", place);
  // Switching between Hand off and Add to group chat changes the menu's height.
  const resize = typeof ResizeObserver === "function" ? new ResizeObserver(place) : undefined;
  resize?.observe(menu);
  return () => {
    view?.removeEventListener("scroll", place, true);
    view?.removeEventListener("resize", place);
    resize?.disconnect();
  };
}
