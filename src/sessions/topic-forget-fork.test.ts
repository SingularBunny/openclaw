import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../agents/sessions/session-manager.js";
import {
  collectForgetTurns,
  cosineSimilarity,
  findForgetCandidates,
  rankForgetCandidates,
} from "./topic-forget-fork.js";

const ts = "2026-11-20T00:00:00.000Z";
const msg = (id: string, role: string, text: string, extra: Record<string, unknown> = {}) =>
  ({
    type: "message",
    id,
    parentId: null,
    timestamp: ts,
    message: { role, content: [{ type: "text", text }], ...extra },
  }) as unknown as SessionEntry;

describe("forget a topic (N11)", () => {
  it("groups the chat into user turns and marks those before the latest summary", () => {
    const entries = [
      msg("u1", "user", "How do I pay taxes?"),
      msg("a1", "assistant", "File a declaration."),
      msg("t1", "toolResult", "ignored output"),
      {
        type: "compaction",
        id: "c1",
        parentId: null,
        timestamp: ts,
        summary: "s",
        firstKeptEntryId: "u2",
        tokensBefore: 1,
      } as unknown as SessionEntry,
      msg("u2", "user", "And the weather?"),
      msg("a2", "assistant", "Sunny."),
      msg("u3", "user", "excluded", { excludeFromContext: true }),
    ];
    const turns = collectForgetTurns(entries);
    expect(turns.map((turn) => [turn.id, turn.entryIds, turn.beforeSummary])).toEqual([
      ["u1", ["u1", "a1", "t1"], true],
      ["u2", ["u2", "a2"], false],
    ]);
    expect(turns[0]!.text).toBe("How do I pay taxes?\nFile a declaration.");
  });

  it("pre-selects turns well above the chat's mean and literal mentions only", () => {
    const turn = (id: string, text: string) => ({
      id,
      entryIds: [id],
      text,
      preview: text,
      beforeSummary: false,
    });
    const turns = [
      turn("a", "погода"),
      turn("b", "кино"),
      turn("c", "еда"),
      turn("d", "вопрос про налоги"),
      turn("e", "о налогах и вычетах"),
    ];
    const ranked = rankForgetCandidates(turns, [0.1, 0.12, 0.11, 0.2, 0.9], "налоги");
    expect(ranked.map((candidate) => [candidate.id, candidate.selected])).toEqual([
      ["a", false],
      ["b", false],
      ["c", false],
      ["d", true],
      ["e", true],
    ]);
    expect(ranked[3]!.literal).toBe(true);
    expect(ranked[4]!.literal).toBe(true);
    expect(ranked[0]).not.toHaveProperty("text");
  });

  it("ranks with the embedder and needs no chat model", async () => {
    const vectors: Record<string, number[]> = {
      topic: [1, 0],
      "How do I pay taxes?\nFile a declaration.": [0.9, 0.1],
      "And the weather?\nSunny.": [0, 1],
    };
    const candidates = await findForgetCandidates({
      target: { agentId: "main", sessionId: "s", sessionKey: "k", storePath: "/x" },
      topic: "topic",
      embedder: {
        embedQuery: async (text) => vectors[text]!,
        embedDocuments: async (texts) => texts.map((text) => vectors[text]!),
      },
      loadEntries: async () => [
        msg("u1", "user", "How do I pay taxes?"),
        msg("a1", "assistant", "File a declaration."),
        msg("u2", "user", "And the weather?"),
        msg("a2", "assistant", "Sunny."),
      ],
    });
    expect(candidates.map((candidate) => candidate.id)).toEqual(["u1", "u2"]);
    expect(candidates[0]!.score).toBeGreaterThan(candidates[1]!.score);
  });

  it("measures cosine similarity", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBe(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });
});
