import { describe, expect, it } from "vitest";
import { parseAcpUsageReply, parseUsageAmount } from "./usage-reply.js";

// Shape of a real `/stats` reply from an ACP agent with a credit account (numbers changed).
const CREDIT_ACCOUNT_REPLY = `**Agent stats**

**Current session**
- Tokens: 0
- Code: +0 / -0 lines, 0 files
- Tool calls: 0

**All-time (this machine)**
- Sessions: 12 (5 completed / 0 failed / 7 interrupted)
- Total session time: 3h 2m 1s
- Tokens: 1.2M
- Cost: 3.50 credits
- Usage by model:
  - **model-a**: 1000 input tokens, 54 output, 25 calls, 0% token cache hit, cost 0.11 credits

**License & quota**
- License: Example AI Ultimate
- Balance left: 42.50 credits
- Top-up: https://example.test/top-up
`;

describe("parseAcpUsageReply", () => {
  it("reads balance and license from a credit account reply", () => {
    expect(parseAcpUsageReply(CREDIT_ACCOUNT_REPLY)).toEqual({
      kind: "usage",
      plan: "Example AI Ultimate",
      balance: { label: "Balance left", amount: 42.5, unit: "credits" },
    });
  });

  it("does not take spent cost for the balance", () => {
    const reply = parseAcpUsageReply("- Cost: 3.50 credits\n- Tokens: 10");
    expect(reply).toEqual({ kind: "usage" });
  });

  it("keeps the plan when an own-API-key account has no balance line", () => {
    const reply = parseAcpUsageReply(
      CREDIT_ACCOUNT_REPLY.replace(/- Balance left:.*\n/, "").replace(/- Top-up:.*\n?/, ""),
    );
    expect(reply).toEqual({ kind: "usage", plan: "Example AI Ultimate" });
  });

  it("accepts stats without an account section as usage with nothing to show", () => {
    expect(parseAcpUsageReply("**Stats**\n- Tokens: 5\n- Tool calls: 1")).toEqual({
      kind: "usage",
    });
  });

  it("accepts bold keys, other units and thousands separators", () => {
    expect(parseAcpUsageReply("* **Credits left:** 1,234.5 USD")).toEqual({
      kind: "usage",
      balance: { label: "Credits left", amount: 1234.5, unit: "USD" },
    });
    expect(parseAcpUsageReply("Balance: 7")).toEqual({
      kind: "usage",
      balance: { label: "Balance", amount: 7, unit: "credits" },
    });
  });

  it("reports the agent's own error text", () => {
    expect(parseAcpUsageReply("Unknown command: /stats")).toEqual({
      kind: "error",
      message: "Unknown command: /stats",
    });
    expect(parseAcpUsageReply("Something went wrong.")).toEqual({
      kind: "error",
      message: "Something went wrong.",
    });
  });

  it("recognizes a logged-out reply", () => {
    expect(parseAcpUsageReply("You are not logged in. Run `agent login`.")).toEqual({
      kind: "logged-out",
    });
  });

  it("reports an empty reply", () => {
    expect(parseAcpUsageReply("  \n\n")).toEqual({
      kind: "error",
      message: "The agent sent an empty reply",
    });
  });

  it("truncates long error text", () => {
    const reply = parseAcpUsageReply("x".repeat(500));
    expect(reply.kind).toBe("error");
    expect(reply.kind === "error" && reply.message.length).toBe(160);
  });
});

describe("parseUsageAmount", () => {
  it.each([
    ["36.01", 36.01],
    ["1,234.50", 1234.5],
    ["1 234,5", 1234.5],
    ["1.234", 1234],
    ["-2.5", -2.5],
    ["12", 12],
  ])("parses %s", (raw, expected) => {
    expect(parseUsageAmount(raw)).toBe(expected);
  });

  it("rejects text", () => {
    expect(parseUsageAmount("n/a")).toBeUndefined();
  });
});
