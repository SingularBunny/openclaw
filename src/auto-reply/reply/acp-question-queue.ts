// Fork: one ACP question at a time per chat, in arrival order.

/**
 * One pending question per session is all the Gateway question service holds, and an ACP
 * agent may ask several things at once (parallel tool calls, a form while a permission is
 * open). Permission questions and forms of the same session wait their turn here instead of
 * failing with "session already has a pending agent input request"; each is then asked and
 * answered on its own. A request whose turn ends while it waits leaves the queue at once.
 */
const questionQueues = new Map<string, Promise<void>>();

async function waitForTurn(previous: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return;
  }
  let onAbort: (() => void) | undefined;
  try {
    await Promise.race([
      previous,
      new Promise<void>((resolve) => {
        onAbort = resolve;
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    if (onAbort) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

export async function inAcpQuestionQueue<T>(
  rawSessionKey: string,
  signal: AbortSignal,
  run: () => Promise<T>,
): Promise<T> {
  const sessionKey = rawSessionKey.trim();
  const previous = questionQueues.get(sessionKey) ?? Promise.resolve();
  let release: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => done);
  questionQueues.set(sessionKey, tail);
  try {
    await waitForTurn(previous, signal);
    return await run();
  } finally {
    release();
    if (questionQueues.get(sessionKey) === tail) {
      questionQueues.delete(sessionKey);
    }
  }
}
