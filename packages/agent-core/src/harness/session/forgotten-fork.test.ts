import { expect, it } from "vitest";
import {
  assistant as assistantMessage,
  user as userMessage,
} from "../compaction/shard-fixtures.test-support.js";
import type { SessionTreeEntry as Entry } from "../types.js";
import { FORGOTTEN_SUMMARY } from "./forgotten-fork.js";
import { buildSessionContext } from "./session.js";

const timestamp = "2026-11-20T00:00:00.000Z";
const base = (id: string, parentId: string | null) => ({ id, parentId, timestamp });

function forgotten<T extends object>(message: T) {
  return { ...message, excludeFromContext: true, __openclaw: { forgotten: { topic: "x", at: 1 } } };
}

function texts(entries: Entry[]): string[] {
  return buildSessionContext(entries).messages.map((message) => {
    const content = (message as { content?: unknown; summary?: string }).content;
    if (typeof content === "string") {
      return content;
    }
    if (Array.isArray(content)) {
      return content.map((part) => (part as { text?: string }).text ?? "").join("");
    }
    return (message as { summary?: string }).summary ?? "";
  });
}

it("a forgotten turn never reaches the model, and later turns do", () => {
  const entries = [
    { ...base("u1", null), type: "message", message: forgotten(userMessage("tax question")) },
    { ...base("a1", "u1"), type: "message", message: forgotten(assistantMessage("tax answer")) },
    { ...base("u2", "a1"), type: "message", message: userMessage("weather?") },
  ] as Entry[];
  expect(texts(entries)).toEqual(["weather?"]);
});

it("a compaction summary written over forgotten messages is replaced by a neutral note", () => {
  const entries = [
    { ...base("u1", null), type: "message", message: forgotten(userMessage("tax question")) },
    { ...base("u2", "u1"), type: "message", message: userMessage("weather?") },
    {
      ...base("c1", "u2"),
      type: "compaction",
      summary: "The user asked about taxes and the weather.",
      firstKeptEntryId: "u2",
      tokensBefore: 100,
    },
    { ...base("u3", "c1"), type: "message", message: userMessage("next") },
  ] as Entry[];
  const all = texts(entries).join("\n");
  expect(all).toContain(FORGOTTEN_SUMMARY);
  expect(all).not.toContain("taxes");
  expect(all).toContain("weather?");
});

it("a summary over ordinary history stays as written", () => {
  const entries = [
    { ...base("u1", null), type: "message", message: userMessage("tax question") },
    {
      ...base("c1", "u1"),
      type: "compaction",
      summary: "The user asked about taxes.",
      firstKeptEntryId: "c1",
      tokensBefore: 100,
    },
  ] as Entry[];
  expect(texts(entries).join("\n")).toContain("The user asked about taxes.");
});
