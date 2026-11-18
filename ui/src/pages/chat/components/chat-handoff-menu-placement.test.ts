import { describe, expect, it } from "vitest";
import { resolveHandoffMenuPlacement } from "./chat-handoff-menu-placement.ts";

const viewport = { width: 1000, height: 800 };
const menu = { width: 240, height: 300 };
const button = (top: number, left = 100) => ({ top, bottom: top + 24, left, right: left + 24 });

describe("hand off menu placement (F76)", () => {
  it("opens above its button when the menu fits there", () => {
    expect(resolveHandoffMenuPlacement(button(600), viewport, menu)).toEqual({
      side: "above",
      top: 296,
      left: 100,
      maxHeight: 320,
    });
  });

  it("flips below the first reply of a short chat instead of hiding under the header", () => {
    const placement = resolveHandoffMenuPlacement(button(120), viewport, menu);
    expect(placement.side).toBe("below");
    expect(placement.top).toBe(148);
    expect(placement.top + Math.min(menu.height, placement.maxHeight)).toBeLessThanOrEqual(792);
  });

  it("clamps the height to the roomier side and keeps the menu inside the window", () => {
    const placement = resolveHandoffMenuPlacement(button(300, 900), { width: 1000, height: 500 }, {
      width: 240,
      height: 600,
    });
    expect(placement.side).toBe("above");
    expect(placement.maxHeight).toBe(288);
    expect(placement.top).toBe(8);
    expect(placement.left).toBe(752);
  });
});
