/* @vitest-environment jsdom */

import { expect, it, vi } from "vitest";
import { GatewayRequestError } from "../../api/gateway-connect-errors.ts";
import { useFakeClock } from "../../test-helpers/fake-clock.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { makeChatHost, requireRecord } from "./chat-host.test-support.ts";
import { idleChatHistory } from "./chat-outbox-recovery.test-support.ts";
import { handleSendChat } from "./chat-send-submit.ts";
import { useChatSendBrowserFixture } from "./outbox-browser.test-support.ts";
useChatSendBrowserFixture();

// Fork: maintenance mode refuses chat.send; the outbox keeps the message as waiting, without a
// red error on the row or a chat error toast (the maintenance banner explains the pause).
it("keeps a message refused by maintenance mode as waiting, not failed", async () => {
  const refusal = new GatewayRequestError({
    code: "UNAVAILABLE",
    message: "chat.send paused: OpenClaw is under maintenance (paused from the Control UI)",
    retryable: true,
    retryAfterMs: 100,
    details: { method: "chat.send", reason: "gateway-maintenance" },
  });
  const send = vi
    .fn((params: unknown) => ({
      runId: requireRecord(params, "send payload").idempotencyKey,
      status: "started",
      messageSeq: 1,
    }))
    .mockRejectedValueOnce(refusal);
  const host = makeChatHost({
    requestHandlers: { "chat.history": idleChatHistory(), "chat.send": send },
    chatMessage: "Message sent during maintenance",
  });
  useFakeClock();
  await handleSendChat(host);

  expect(host.chatQueue).toEqual([expect.objectContaining({ sendState: "waiting-reconnect" })]);
  expect(host.chatQueue[0]?.sendError).toBeUndefined();
  expect(host.chatError).toBeNull();
  await vi.advanceTimersByTimeAsync(100);
  await waitForFast(() => {
    expect(send).toHaveBeenCalledTimes(2);
    expect(host.chatQueue).toEqual([]);
  });
});
