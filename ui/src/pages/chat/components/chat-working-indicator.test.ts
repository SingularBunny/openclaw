import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { selectWorkingClawSurprise } from "./chat-working-indicator-surprise.ts";
import { renderChatWorkingIndicator } from "./chat-working-indicator.ts";

describe("renderChatWorkingIndicator", () => {
  it("selects the working glyph independently of the mascot and keeps text when hidden", () => {
    const container = document.createElement("div");
    const part = { kind: "reading-indicator" as const, key: "brand-test", startedAt: 1 };
    render(
      renderChatWorkingIndicator(part, { mascot: "claw", workingIndicator: "dots" }),
      container,
    );
    expect(container.querySelectorAll(".chat-reading-indicator--neutral > span")).toHaveLength(3);
    render(
      renderChatWorkingIndicator(part, { mascot: "none", workingIndicator: "claw" }),
      container,
    );
    expect(container.querySelector(".chat-reading-indicator svg")).not.toBeNull();
    render(renderChatWorkingIndicator(part, { workingIndicator: "brand" }), container);
    expect(container.querySelector(".chat-reading-indicator--brand")).not.toBeNull();
    render(
      renderChatWorkingIndicator(part, { workingIndicator: "none", workingPhrases: [] }),
      container,
    );
    expect(container.querySelector(".chat-reading-indicator")).toBeNull();
    expect(
      container
        .querySelector(".chat-working-indicator__status > span")
        ?.classList.contains("sr-only"),
    ).toBe(false);
    expect(container.textContent).toContain("Working");
  });

  it("shows the Claude CLI background tasks line instead of a working phrase", () => {
    const container = document.createElement("div");
    render(
      renderChatWorkingIndicator(
        { kind: "reading-indicator", key: "background-test", startedAt: 1 },
        { backgroundTasks: { runId: "r", count: 2, agents: 2, waiting: true } },
      ),
      container,
    );
    expect(container.querySelector(".chat-working-indicator__background-tasks")?.textContent).toBe(
      "Waiting for 2 background agents to finish",
    );
    expect(container.querySelector("openclaw-working-phrase")).toBeNull();
  });

  it("lists each background task under the counter line with a stop control", async () => {
    const container = document.createElement("div");
    const stops: string[] = [];
    let accept = true;
    const draw = (onStop?: (taskId: string) => Promise<boolean>) =>
      render(
        renderChatWorkingIndicator(
          { kind: "reading-indicator", key: "background-rows", startedAt: 1 },
          {
            backgroundTasks: {
              runId: "r",
              count: 2,
              agents: 1,
              waiting: false,
              tasks: [
                {
                  taskId: "a1",
                  taskType: "local_agent",
                  subagentType: "Explore",
                  description: "Map the parser",
                  status: "running",
                  startedAt: 1_000,
                },
                {
                  taskId: "b1",
                  taskType: "local_bash",
                  description: "npm test",
                  status: "running",
                  startedAt: 2_000,
                },
                {
                  taskId: "c1",
                  taskType: "local_agent",
                  description: "Check docs",
                  status: "failed",
                  startedAt: 500,
                  endedAt: 900,
                },
              ],
            },
            onStopBackgroundTask: onStop,
          },
        ),
        container,
      );
    draw(async (taskId) => {
      stops.push(taskId);
      return accept;
    });
    const summary = container.querySelector("details.chat-cli-tasks > summary");
    expect(summary?.textContent?.trim()).toBe("2 background tasks running");
    const rows = [...container.querySelectorAll<HTMLElement>(".chat-cli-tasks__row")];
    expect(rows.map((row) => row.dataset.taskId)).toEqual(["a1", "b1", "c1"]);
    expect(rows[0]?.querySelector(".chat-cli-tasks__type")?.textContent).toBe("Explore");
    expect(rows[1]?.querySelector(".chat-cli-tasks__type")?.textContent).toBe("shell");
    expect(rows[2]?.querySelector(".chat-cli-tasks__status")?.textContent).toBe("Failed");
    expect(rows[0]?.querySelector("openclaw-elapsed-time")).toHaveProperty("startMs", 1_000);
    expect(rows[2]?.querySelector("openclaw-elapsed-time")).toHaveProperty("endMs", 900);
    expect(rows[2]?.querySelector("button")).toBeNull();

    const stop = rows[0]?.querySelector<HTMLButtonElement>(".chat-cli-tasks__stop");
    expect(stop?.getAttribute("aria-label")).toBe("Stop Map the parser");
    stop?.click();
    expect(stop?.disabled).toBe(true);
    await Promise.resolve();
    expect(stops).toEqual(["a1"]);

    accept = false;
    const refused = rows[1]?.querySelector<HTMLButtonElement>(".chat-cli-tasks__stop");
    refused?.click();
    await vi.waitFor(() => expect(refused?.disabled).toBe(false));
    expect(refused?.disabled).toBe(false);
    expect(refused?.title).toBe("This task is no longer running in this Claude session.");

    draw();
    expect(container.querySelector(".chat-cli-tasks__stop")).toBeNull();
  });

  it("renders neutral dots without claw surprises and forwards authored phrases", () => {
    const container = document.createElement("div");
    const workingPhrases = ["Building"];
    render(
      renderChatWorkingIndicator(
        { kind: "reading-indicator", key: findRenderKey(true), startedAt: 1 },
        { mascot: "none", workingPhrases },
      ),
      container,
    );
    const bubble = container.querySelector(".chat-reading-indicator--neutral");
    expect(bubble?.querySelectorAll("span")).toHaveLength(3);
    expect(bubble?.querySelector("svg")).toBeNull();
    expect(
      [...bubble!.classList].filter((name) => name.startsWith("chat-reading-indicator--")),
    ).toEqual(["chat-reading-indicator--neutral"]);
    expect(container.querySelector("openclaw-working-phrase")).toHaveProperty(
      "phrases",
      workingPhrases,
    );
  });
  // The render path seeds with the module's per-page-load salt, so probe that
  // same default salt for keys that do (and do not) surprise this session.
  function findRenderKey(wantSurprise: boolean): string {
    for (let index = 0; index < 10_000; index++) {
      const key = `probe:${index}`;
      if (Boolean(selectWorkingClawSurprise(key)) === wantSurprise) {
        return key;
      }
    }
    throw new Error(`no render key with surprise=${String(wantSurprise)}`);
  }

  function surpriseClassesFor(key: string, waitingApproval: boolean): string[] {
    const container = document.createElement("div");
    render(
      renderChatWorkingIndicator(
        { kind: "reading-indicator", key, startedAt: 1 },
        { waitingApproval },
      ),
      container,
    );
    const bubble = container.querySelector(".chat-reading-indicator");
    expect(bubble).not.toBeNull();
    return [...(bubble?.classList ?? [])].filter((name) =>
      name.startsWith("chat-reading-indicator--"),
    );
  }

  it("keeps approval waits on the default claw even for surprising keys", () => {
    expect(surpriseClassesFor(findRenderKey(true), true)).toEqual([]);
  });
});
