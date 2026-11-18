// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  isAutomationDetailsShown,
  parseAutomationDetailsSettings,
  setAutomationDetailsShown,
} from "./chat-automation-details.ts";

const CHAT = "agent:main:cron:job-0001";
const OTHER = "agent:main:cron:job-0002";

describe("automation details setting (fork)", () => {
  it("is off by default and follows the global default otherwise", () => {
    expect(isAutomationDetailsShown({}, CHAT)).toBe(false);
    expect(isAutomationDetailsShown({ chatShowAutomationDetails: true }, CHAT)).toBe(true);
  });

  it("lets one chat override the default without touching other chats", () => {
    const shown = setAutomationDetailsShown({}, CHAT, true);
    expect(isAutomationDetailsShown(shown, CHAT)).toBe(true);
    expect(isAutomationDetailsShown(shown, OTHER)).toBe(false);

    const global = { chatShowAutomationDetails: true };
    const hidden = { ...global, ...setAutomationDetailsShown(global, CHAT, false) };
    expect(isAutomationDetailsShown(hidden, CHAT)).toBe(false);
    expect(isAutomationDetailsShown(hidden, OTHER)).toBe(true);
  });

  it("clears the override when the chat goes back to the default", () => {
    const shown = setAutomationDetailsShown({}, CHAT, true);
    expect(setAutomationDetailsShown(shown, CHAT, false)).toEqual({
      chatAutomationDetailsSessionKeys: undefined,
      chatAutomationDetailsHiddenSessionKeys: undefined,
    });
  });

  it("keeps only valid stored values", () => {
    expect(
      parseAutomationDetailsSettings({
        chatShowAutomationDetails: "yes",
        chatAutomationDetailsSessionKeys: [CHAT, " ", 3],
      }),
    ).toEqual({
      chatShowAutomationDetails: undefined,
      chatAutomationDetailsSessionKeys: [CHAT],
      chatAutomationDetailsHiddenSessionKeys: undefined,
    });
  });
});
