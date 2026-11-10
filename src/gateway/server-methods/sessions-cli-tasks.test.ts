import { describe, expect, it, vi } from "vitest";
import { createSessionCliTaskHandlers } from "./sessions-cli-tasks.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

async function invoke(
  stopTask: Parameters<typeof createSessionCliTaskHandlers>[0],
  params: unknown,
) {
  const respond = vi.fn<RespondFn>();
  await createSessionCliTaskHandlers(stopTask)["sessions.cliTasks.stop"]!({
    params,
    respond,
    context: {
      getRuntimeConfig: () => ({ agents: { entries: { main: {} } } }),
    } as unknown as GatewayRequestContext,
  } as never);
  return respond;
}

describe("sessions.cliTasks.stop", () => {
  it("asks the session's live Claude CLI process to stop the task", async () => {
    const stopTask = vi.fn(async () => true);
    const respond = await invoke(stopTask, { sessionKey: "agent:main:main", taskId: "task-1" });
    expect(stopTask).toHaveBeenCalledExactlyOnceWith(
      { agentId: "main", sessionKeys: expect.arrayContaining(["agent:main:main"]) },
      "task-1",
    );
    expect(respond).toHaveBeenCalledExactlyOnceWith(true, { requested: true });
  });

  it("reports a task no live process knows", async () => {
    const respond = await invoke(
      vi.fn(async () => false),
      { sessionKey: "agent:main:main", taskId: "gone" },
    );
    expect(respond).toHaveBeenCalledExactlyOnceWith(true, { requested: false });
  });

  it("rejects malformed requests without touching the CLI", async () => {
    const stopTask = vi.fn(async () => true);
    const respond = await invoke(stopTask, { sessionKey: "agent:main:main" });
    expect(stopTask).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
  });
});
