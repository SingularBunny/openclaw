import { describe, expect, it } from "vitest";
import {
  cronChatSessionKey,
  cronJobsDeliveringToChat,
  cronRunBelongsToChat,
} from "./run-history-chat.js";

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

  it("keeps runs recorded in the chat, its run sessions, or by its jobs", () => {
    const inChat = cronRunBelongsToChat(chat, new Set(["job-follow-up"]));
    expect(inChat({ jobId: "job-owner", sessionKey: `${chat}:run:r1` })).toBe(true);
    expect(inChat({ jobId: "job-removed", sessionKey: chat })).toBe(true);
    expect(inChat({ jobId: "job-follow-up" })).toBe(true);
    expect(inChat({ jobId: "job-other", sessionKey: "agent:ops:cron:job-other" })).toBe(false);
    expect(inChat({ jobId: "job-other" })).toBe(false);
  });
});
