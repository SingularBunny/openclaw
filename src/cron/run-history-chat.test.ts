import { describe, expect, it } from "vitest";
import { cronChatSessionKey, cronJobsDeliveringToChat } from "./run-history-chat.js";

const chat = "agent:ops:cron:job-owner";

describe("cron run history for one chat", () => {
  it("folds isolated run sessions into their automation chat", () => {
    expect(cronChatSessionKey(`${chat}:run:abc`)).toBe(chat);
    expect(cronChatSessionKey(" Agent:Ops:Cron:Job-Owner ")).toBe(chat);
  });

  it("finds the owning automation and jobs that target the chat by session", () => {
    const ids = cronJobsDeliveringToChat(`${chat}:run:abc`, [
      { id: "job-owner", sessionTarget: "isolated" },
      { id: "job-follow-up", sessionTarget: `session:${chat}` },
      { id: "job-elsewhere", sessionTarget: "session:agent:ops:main" },
      { id: "job-main", sessionTarget: "main" },
    ]);
    expect([...ids].toSorted()).toEqual(["job-follow-up", "job-owner"]);
  });

  it("finds jobs set up from the chat, which report to it", () => {
    const ids = cronJobsDeliveringToChat(chat, [
      { id: "job-owner", sessionTarget: "isolated" },
      { id: "job-watcher", sessionTarget: "current", sessionKey: "Agent:Ops:Cron:Job-Owner" },
      { id: "job-other", sessionTarget: "current", sessionKey: "agent:ops:main" },
    ]);
    expect([...ids].toSorted()).toEqual(["job-owner", "job-watcher"]);
  });
});
