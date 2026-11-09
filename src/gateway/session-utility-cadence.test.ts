import { describe, expect, it } from "vitest";
import {
  resolveActivityRecapRefreshMs,
  resolveSessionObserverMinDigestIntervalMs,
} from "./session-utility-cadence.js";

// Fork: utility-model cadence for running chats comes from the environment, read on use.
describe("utility-model cadence settings", () => {
  it.each([
    [undefined, 12_000, 90_000],
    ["", 12_000, 90_000],
    ["0", 12_000, 90_000],
    ["-5", 12_000, 90_000],
    ["1.5", 12_000, 90_000],
    ["abc", 12_000, 90_000],
    [" 120000 ", 120_000, 120_000],
  ])("maps %j to the observer and recap intervals", (value, observer, recap) => {
    expect(
      resolveSessionObserverMinDigestIntervalMs({
        OPENCLAW_SESSION_OBSERVER_MIN_INTERVAL_MS: value,
      }),
    ).toBe(observer);
    expect(resolveActivityRecapRefreshMs({ OPENCLAW_ACTIVITY_RECAP_MIN_INTERVAL_MS: value })).toBe(
      recap,
    );
  });
});
