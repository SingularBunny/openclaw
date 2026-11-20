import { describe, expect, it } from "vitest";
import { sidebarShowsCronRow } from "./automation-child-fork.ts";

describe("sidebarShowsCronRow", () => {
  const own = { key: "agent:ops:cron:ce18c1ed" };
  const child = {
    key: "agent:ops:cron:528c3083",
    automationParentKey: "agent:ops:cron:ce18c1ed",
  };

  it("lists an automation the owner set up only when automation sessions are shown", () => {
    expect(sidebarShowsCronRow(own, true)).toBe(true);
    expect(sidebarShowsCronRow(own, false)).toBe(false);
  });

  it("never lists the run session of a job set up from a chat", () => {
    expect(sidebarShowsCronRow(child, true)).toBe(false);
    expect(sidebarShowsCronRow(child, false)).toBe(false);
  });

  it("leaves ordinary chats alone", () => {
    expect(sidebarShowsCronRow({ key: "agent:main:main", automationParentKey: "x" }, false)).toBe(
      true,
    );
  });
});
