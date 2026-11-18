// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { createProps } from "./chat-thread.test-support.ts";
import { buildCachedChatItems, resetChatThreadState } from "./chat-thread.ts";

afterEach(() => resetChatThreadState());

const JOB = "job-0001";
const prompt = `[cron:${JOB} nightly-report] Summarize the queue.\n${"Step details. ".repeat(150)}`;
const cliPrompt = `${prompt}\n\nUse the message tool if you need to notify the user directly.`;
const reminder =
  "A scheduled reminder has been triggered. The reminder content is:\n\nCheck the queue.";
const repair =
  "Automation repair request from the scheduler, not a user message. Do not relay it.\nPayload";

function render(messages: unknown[], showAutomationDetails?: boolean, searchQuery = "") {
  return buildCachedChatItems(
    createProps({
      paneId: "automation-rows",
      messages,
      pendingInputs: [],
      searchOpen: Boolean(searchQuery),
      searchQuery,
      ...(showAutomationDetails === undefined ? {} : { showAutomationDetails }),
    }),
  );
}

const scheduled = (timestamp: number, seq: number) => ({
  role: "user",
  content: prompt,
  timestamp,
  provenance: { kind: "internal_system", sourceTool: "cron" },
  __openclaw: { id: `cron-${seq}`, seq, senderIsOwner: false },
});
const imported = (content: string, timestamp: number, seq: number) => ({
  role: "user",
  content: [{ type: "text", text: content }],
  timestamp,
  __openclaw: { id: `cli-${seq}`, seq, importedFrom: "claude-cli" },
});
const reply = (text: string, timestamp: number, seq: number) => ({
  role: "assistant",
  content: text,
  timestamp,
  __openclaw: { id: `reply-${seq}`, seq },
});

const notices = (items: ReturnType<typeof render>) =>
  items.filter((item) => item.kind === "notice") as Array<Record<string, unknown>>;
const userTexts = (items: ReturnType<typeof render>) =>
  (
    items.filter((item) => item.kind === "group" && item.role === "user") as Array<{
      messages: Array<{ message: { content: unknown } }>;
    }>
  ).flatMap((group) => group.messages.map((entry) => JSON.stringify(entry.message.content)));

describe("automation rows (fork)", () => {
  it.each([
    ["scheduler prompt", scheduled(1000, 1), "Automation · nightly-report", "history"],
    ["CLI prompt copy", imported(cliPrompt, 1000, 1), "Automation · nightly-report", "history"],
    ["scheduled reminder", imported(reminder, 1000, 1), "Scheduled reminder", "bell"],
  ])(
    "collapses a %s into one line with the full text behind a disclosure",
    (_, row, label, icon) => {
      const [notice] = notices(render([row, reply("Done.", 1100, 2)]));
      expect(notice).toMatchObject({ label, icon, collapsedBody: true, startsTurn: true });
      expect(notice?.metric).toEqual(expect.any(String));
      expect(String(notice?.text).length).toBeGreaterThan(40);
    },
  );

  it("keeps the repair request's fixed summary for both provenance and text fallback", () => {
    for (const row of [
      {
        role: "user",
        content: repair,
        timestamp: 1000,
        provenance: { kind: "internal_system", sourceTool: "cron_failure_repair", jobId: JOB },
        __openclaw: { id: "repair-1", seq: 1 },
      },
      imported(repair, 1000, 1),
    ]) {
      resetChatThreadState();
      const [notice] = notices(render([row]));
      expect(notice).toMatchObject({ label: "System · automation recovery", icon: "cpu" });
      expect(notice?.text).not.toContain("Payload");
      expect(notice?.collapsedBody).toBeUndefined();
    }
  });

  it("leaves ordinary and owner-sent user messages untouched", () => {
    const items = render([
      {
        role: "user",
        content: "Please check [cron:abc x] later",
        timestamp: 1,
        __openclaw: { seq: 1 },
      },
      {
        role: "user",
        content: `[cron:${JOB} quoted] pasted by the owner`,
        timestamp: 2,
        __openclaw: { seq: 2, senderIsOwner: true },
      },
      {
        role: "user",
        content: reminder,
        timestamp: 3,
        provenance: { kind: "inter_session", sourceTool: "sessions_send" },
        __openclaw: { seq: 3 },
      },
    ]);
    expect(notices(items).filter((notice) => notice.automation)).toEqual([]);
    expect(userTexts(items).join("\n")).toContain("Please check [cron:abc x] later");
    expect(userTexts(items).join("\n")).toContain("pasted by the owner");
  });

  it("shows a run's prompt once when the CLI copy follows the scheduler row", () => {
    const items = render([
      scheduled(10_000, 1),
      imported(cliPrompt, 12_000, 2),
      reply("First run done.", 13_000, 3),
      imported(cliPrompt, 900_000, 4),
      reply("Second run done.", 901_000, 5),
    ]);
    const rows = notices(items).filter((notice) => notice.automation);
    expect(rows.map((row) => row.key)).toHaveLength(2);
    expect(rows[0]).toMatchObject({ automation: { structured: true } });
    expect(rows[1]).toMatchObject({ automation: { structured: false } });
    expect(userTexts(items)).toEqual([]);
  });

  it("hides the technical text but keeps a bare run line and the replies when details are off", () => {
    const items = render(
      [scheduled(10_000, 1), imported(cliPrompt, 12_000, 2), reply("Queue is empty.", 13_000, 3)],
      false,
    );
    const rows = notices(items).filter((notice) => notice.automation);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ label: "Automation · nightly-report", text: "" });
    expect(rows[0]?.collapsedBody).toBeUndefined();
    expect(JSON.stringify(items)).toContain("Queue is empty.");
    expect(JSON.stringify(items)).not.toContain("Step details.");
  });

  it("still finds the full prompt text through search", () => {
    const items = render(
      [scheduled(10_000, 1), reply("Unrelated.", 11_000, 2)],
      true,
      "Step details",
    );
    expect(notices(items).find((notice) => notice.automation)).toMatchObject({
      text: expect.stringContaining("Step details."),
    });
  });
});
