import { describe, expect, it, vi } from "vitest";
import { forgetPicks, runForgetTopic, type ChatForgetCandidate } from "./chat-forget-fork.tsx";

const candidate = (id: string, entryIds: string[]): ChatForgetCandidate => ({
  id,
  entryIds,
  preview: id,
  beforeSummary: false,
  score: 0.5,
  literal: false,
  selected: false,
});

describe("Forget a topic (N11)", () => {
  it("sends the rows of the ticked turns and the ticked memory paragraphs only", () => {
    const list = [candidate("u1", ["u1", "a1"]), candidate("u2", ["u2", "a2"])];
    const memory = [
      {
        id: "m1",
        file: "/w/MEMORY.md",
        hash: "h1",
        preview: "p",
        score: 1,
        literal: true,
        selected: true,
      },
      {
        id: "m2",
        file: "/w/memory/x.md",
        hash: "h2",
        preview: "q",
        score: 0,
        literal: false,
        selected: false,
      },
    ];
    expect(forgetPicks(list, memory, new Set(["u2", "m1"]))).toEqual({
      entryIds: ["u2", "a2"],
      memory: [{ file: "/w/MEMORY.md", hash: "h1" }],
    });
    expect(forgetPicks(list, memory, new Set())).toEqual({ entryIds: [], memory: [] });
  });

  it("finds, lets the user pick, then applies to the same chat", async () => {
    const request = vi.fn(async (method: string) =>
      method === "chat.forget.find"
        ? { candidates: [candidate("u1", ["u1", "a1"]), candidate("u2", ["u2"])] }
        : { forgotten: ["u1", "a1"] },
    );
    const host = { sessionKey: "agent:main:main", client: { request } as never };
    const forgotten = await runForgetTopic(host, {
      askTopic: async (find) => ((await find("taxes")) === null ? "taxes" : null),
      pick: async (_topic, candidates) => ({ entryIds: candidates[0]!.entryIds, memory: [] }),
    });
    expect(forgotten).toBe(2);
    expect(request).toHaveBeenNthCalledWith(1, "chat.forget.find", {
      sessionKey: "agent:main:main",
      topic: "taxes",
    });
    expect(request).toHaveBeenNthCalledWith(2, "chat.forget.apply", {
      sessionKey: "agent:main:main",
      topic: "taxes",
      entryIds: ["u1", "a1"],
      memory: [],
    });
  });

  it("does nothing when nothing is found or the chat changed", async () => {
    const request = vi.fn(async () => ({ candidates: [] }));
    const host = { sessionKey: "k", client: { request } as never };
    const pick = vi.fn();
    expect(
      await runForgetTopic(host, {
        askTopic: async (find) => {
          expect(await find("x")).toBe("Nothing in this chat to forget.");
          return null;
        },
        pick,
      }),
    ).toBe(0);
    expect(pick).not.toHaveBeenCalled();
  });
});
