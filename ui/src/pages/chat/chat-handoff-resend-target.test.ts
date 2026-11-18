import { expect, it } from "vitest";
import { pickerHandoffModel } from "./chat-handoff-resend-target.ts";

it("re-sends a failed turn to the default model when the default row is chosen", () => {
  const opts = { bound: false, resend: "Second question", defaultModel: "demo/alpha" };
  expect(pickerHandoffModel(null, opts)).toBe("demo/alpha");
  expect(pickerHandoffModel("demo/beta", opts)).toBe("demo/beta");
});

it("switches plainly without a pending re-send unless an agent is bound", () => {
  const opts = { bound: false, resend: undefined, defaultModel: "demo/alpha" };
  expect(pickerHandoffModel("demo/beta", opts)).toBeUndefined();
  expect(pickerHandoffModel(null, opts)).toBeUndefined();
  expect(pickerHandoffModel("demo/beta", { ...opts, bound: true })).toBe("demo/beta");
  expect(pickerHandoffModel(null, { ...opts, bound: true })).toBeUndefined();
});
