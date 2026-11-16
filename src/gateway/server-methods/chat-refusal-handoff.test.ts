import { describe, expect, it, vi } from "vitest";
import { createChatRefusalHandoffHandlers } from "./chat-refusal-handoff.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

async function invoke(params: unknown, sessionId: string | null = "s1") {
  const respond = vi.fn<RespondFn>();
  const exclude = vi.fn(async () => ({ entryIds: ["u1", "a1"], excluded: ["u1", "a1"] }));
  const readEntry = vi.fn(async () => (sessionId ? ({ sessionId } as never) : undefined));
  const logGateway = { info: vi.fn(), warn: vi.fn() };
  await createChatRefusalHandoffHandlers(exclude, readEntry)["chat.refusal.handoff"]!({
    params,
    respond,
    context: {
      getRuntimeConfig: () => ({ agents: { entries: { main: {} } } }),
      logGateway,
    } as unknown as GatewayRequestContext,
  } as never);
  return { respond, exclude, logGateway };
}

describe("chat.refusal.handoff (I14)", () => {
  it("logs the hand-off and leaves the refused turn out of the model context", async () => {
    const { respond, exclude, logGateway } = await invoke({
      sessionKey: "agent:main:main",
      messageId: "a1",
      signal: "marker",
      target: "Y\nFree",
    });
    expect(exclude).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        messageId: "a1",
        signal: "marker",
        target: expect.objectContaining({ agentId: "main", sessionId: "s1" }),
      }),
    );
    expect(respond).toHaveBeenCalledExactlyOnceWith(true, { excluded: ["u1", "a1"] });
    expect(logGateway.info).toHaveBeenCalledExactlyOnceWith(
      expect.stringMatching(
        /^chat refusal handoff: session=agent:main:main message=a1 signal=marker to="Y Free" excluded=2\/2$/u,
      ),
    );
  });

  it("still logs when the chat has no session yet", async () => {
    const { respond, exclude, logGateway } = await invoke(
      { sessionKey: "agent:main:main", messageId: "a1", signal: "phrase" },
      null,
    );
    expect(exclude).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(true, { excluded: [] });
    expect(logGateway.info).toHaveBeenCalledOnce();
  });

  it("rejects malformed requests", async () => {
    const { respond, exclude } = await invoke({
      sessionKey: "agent:main:main",
      messageId: "a1",
      signal: "auto",
    });
    expect(exclude).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
  });
});
