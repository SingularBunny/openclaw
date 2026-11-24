import { describe, expect, it } from "vitest";
import { inAcpQuestionQueue } from "./acp-question-queue.js";

function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("ACP question queue", () => {
  it("runs a form after the permission question open in the same chat", async () => {
    const order: string[] = [];
    const permission = deferred();
    const signal = new AbortController().signal;
    const first = inAcpQuestionQueue("agent:main:dashboard:q", signal, async () => {
      order.push("permission asked");
      await permission.promise;
      order.push("permission answered");
    });
    const second = inAcpQuestionQueue(" agent:main:dashboard:q ", signal, async () => {
      order.push("form asked");
    });
    const otherChat = inAcpQuestionQueue("agent:main:dashboard:other", signal, async () => {
      order.push("other chat asked");
    });
    await otherChat;
    expect(order).toEqual(["permission asked", "other chat asked"]);
    permission.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual([
      "permission asked",
      "other chat asked",
      "permission answered",
      "form asked",
    ]);
  });

  it("lets a waiting request go at once when its turn ends, and keeps the order for the rest", async () => {
    const hold = deferred();
    const order: string[] = [];
    const first = inAcpQuestionQueue("agent:main:dashboard:r", new AbortController().signal, () =>
      hold.promise.then(() => {
        order.push("first");
      }),
    );
    const controller = new AbortController();
    const cancelled = inAcpQuestionQueue("agent:main:dashboard:r", controller.signal, async () => {
      order.push(controller.signal.aborted ? "cancelled ran aborted" : "cancelled ran");
    });
    const third = inAcpQuestionQueue(
      "agent:main:dashboard:r",
      new AbortController().signal,
      async () => {
        order.push("third");
      },
    );
    controller.abort();
    await cancelled;
    expect(order).toEqual(["cancelled ran aborted"]);
    hold.resolve();
    await Promise.all([first, third]);
    expect(order).toEqual(["cancelled ran aborted", "first", "third"]);
  });
});
