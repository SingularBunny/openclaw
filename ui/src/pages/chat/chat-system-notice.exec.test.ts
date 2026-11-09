// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { createProps } from "./chat-thread.test-support.ts";
import { buildCachedChatItems, resetChatThreadState } from "./chat-thread.ts";

afterEach(() => resetChatThreadState());

function render(messages: unknown[]) {
  return buildCachedChatItems(
    createProps({ paneId: "exec-notices", messages, pendingInputs: [], searchOpen: false }),
  );
}

describe("background exec completion notices (fork)", () => {
  it("renders an exec completion as a collapsed system notice, not an operator message", () => {
    const text =
      "Exec completed (calm-wil, code 0) :: compiled\nExec failed (brisk-ca, signal SIGTERM) :: INSERT INTO tmp";
    const items = render([
      { role: "user", content: "Check the build", timestamp: 900, __openclaw: { seq: 1 } },
      { role: "assistant", content: "Started it.", timestamp: 950, __openclaw: { seq: 2 } },
      {
        role: "user",
        content: text,
        timestamp: 1000,
        provenance: { kind: "internal_system", sourceTool: "exec" },
        __openclaw: { id: "input-2", seq: 3 },
      },
    ]);
    const notice = items.find((item) => item.kind === "notice");
    expect(notice).toMatchObject({
      kind: "notice",
      icon: "terminal",
      label: "System · background command finished",
      text,
      collapsedBody: true,
      startsTurn: true,
    });
    const userGroups = items.filter(
      (item) => item.kind === "group" && item.role === "user",
    ) as Array<{ messages: Array<{ message: { content: unknown } }> }>;
    expect(
      userGroups.flatMap((group) => group.messages.map((entry) => entry.message.content)),
    ).toEqual(["Check the build"]);
  });
});
