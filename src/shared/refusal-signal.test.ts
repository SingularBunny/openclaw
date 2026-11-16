import { describe, expect, it } from "vitest";
import {
  matchesRefusalPhrase,
  readProviderRefusal,
  readRefusalHandoff,
  readStoredRefusal,
  REFUSAL_MARKER,
  REFUSAL_PHRASE_MAX_CHARS,
  stripRefusalMarker,
} from "./refusal-signal.js";

const reply = (text: string, extra: Record<string, unknown> = {}) => ({
  role: "assistant",
  content: [{ type: "text", text }],
  ...extra,
});

describe("refusal signals (I14)", () => {
  it("reads the API signal any provider records", () => {
    const diagnostic = reply("", {
      stopReason: "error",
      diagnostics: [{ type: "provider_refusal", timestamp: 1, details: { category: "cyber" } }],
    });
    expect(readProviderRefusal(diagnostic)).toEqual({ signal: "provider", category: "cyber" });
    // Claude CLI and ACP rows carry it as metadata.
    expect(
      readProviderRefusal(reply("No.", { __openclaw: { refusal: { signal: "provider" } } })),
    ).toEqual({ signal: "provider" });
    expect(readProviderRefusal(reply("", { errorCode: "misalignment_policy_violation" }))).toEqual({
      signal: "provider",
      category: "misalignment",
    });
    // Unsafe categories are dropped, user rows never count.
    expect(
      readProviderRefusal(
        reply("", { diagnostics: [{ type: "provider_refusal", details: { category: "<b>" } }] }),
      ),
    ).toEqual({ signal: "provider" });
    expect(readProviderRefusal({ role: "user", diagnostics: [{ type: "provider_refusal" }] })).toBe(
      undefined,
    );
    expect(readProviderRefusal(reply("Sure, here it is."))).toBeUndefined();
  });

  it("reads and strips the model's own marker", () => {
    const text = `I won't do that part.\n\n${REFUSAL_MARKER}\n`;
    expect(readStoredRefusal(reply(text))).toEqual({ signal: "marker" });
    expect(readStoredRefusal(reply("ok <!--openclaw:REFUSAL-->"))).toEqual({ signal: "marker" });
    expect(stripRefusalMarker(text)).toBe("I won't do that part.\n\n");
    expect(stripRefusalMarker("plain")).toBe("plain");
    expect(readStoredRefusal(reply("<!-- other comment -->"))).toBeUndefined();
  });

  it("matches a short reply that opens by declining, in English and Russian", () => {
    for (const text of [
      "I can't help with that.",
      "I’m sorry, but I cannot assist with creating malware.",
      "I'm not able to help with this request.",
      "Sorry — I must decline.",
      "Извините, но я не могу помочь с этим запросом.",
      "К сожалению, не могу выполнить эту просьбу.",
      "Я вынужден отказать.",
    ]) {
      expect(matchesRefusalPhrase(text), text).toBe(true);
    }
  });

  it("does not match ordinary answers", () => {
    for (const text of [
      "Here is the function you asked for.",
      "The CLI can't find the file; check the path and try again.",
      "Вот как это сделать: откройте настройки.",
      "Не могу сказать точно, но вероятно это кеш.",
      "Помочь могу так: сначала соберите проект.",
      `${"Background. ".repeat(20)}I can't help with that part.`,
      `I can't help with the first part, but here is the rest. ${"Details. ".repeat(80)}`,
    ]) {
      expect(matchesRefusalPhrase(text), text).toBe(false);
    }
    expect("x".repeat(REFUSAL_PHRASE_MAX_CHARS + 1).length).toBeGreaterThan(
      REFUSAL_PHRASE_MAX_CHARS,
    );
  });

  it("knows a turn already handed off", () => {
    expect(readRefusalHandoff(reply("x", { __openclaw: { refusalHandoff: { at: 1 } } }))).toBe(
      true,
    );
    expect(readRefusalHandoff(reply("x"))).toBe(false);
  });
});
