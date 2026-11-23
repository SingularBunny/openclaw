import { describe, expect, it, vi } from "vitest";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { TranscriptSearchContent } from "./chat-transcript-search-content.tsx";
import { findTranscriptMatches } from "./chat-transcript-search-fork.tsx";
import { TranscriptSearchState } from "./chat-transcript-search-state.ts";

function transcript(html: string) {
  const column = document.createElement("div");
  column.className = "chat-main__conversation-column";
  column.innerHTML = html;
  document.body.append(column);
  return column;
}

function mountSearch(column: HTMLElement, query: string) {
  const search = new TranscriptSearchState();
  search.toggle();
  const view = mountSolid(() => <TranscriptSearchContent search={search} query={query} />, {
    container: column.appendChild(document.createElement("div")),
  });
  const count = () => view.container.querySelector(".agent-chat__search-count")?.textContent;
  return { view, count };
}

describe("whole-chat transcript search (fork)", () => {
  it("finds the query in message text, case-insensitively, and not in the search bar, buttons or details", () => {
    const column = transcript(
      `<div class="agent-chat__search-bar"><span>Antibot</span></div>
       <aside class="chat-details"><h3>Antibot automations</h3></aside>
       <div class="chat-group"><p>The antibot check failed. ANTIBOT again.</p><button>antibot</button></div>`,
    );
    const ranges = findTranscriptMatches(column, "antibot");
    expect(ranges.map((range) => range.toString())).toEqual(["antibot", "ANTIBOT"]);
    expect(findTranscriptMatches(column, "  ")).toEqual([]);
    column.remove();
  });

  it("shows the match count from the newest match and moves with Enter and Shift+Enter", async () => {
    const column = transcript(
      `<div class="chat-group"><p>one antibot</p></div><div class="chat-group"><p>two antibot</p></div>`,
    );
    const { view, count } = mountSearch(column, "antibot");
    await waitForSolid(() => expect(count()).toBe("2 / 2"));
    const input = view.container.querySelector("input")!;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await waitForSolid(() => expect(count()).toBe("1 / 2"));
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true }),
    );
    await waitForSolid(() => expect(count()).toBe("2 / 2"));
    view.unmount();
    column.remove();
  });

  it("presses Show earlier until the chat's start, never while a page is loading", async () => {
    vi.useFakeTimers();
    try {
      const column = transcript(
        `<div class="chat-history-boundary"><button class="chat-history-boundary__action">Show earlier</button></div>
         <div class="chat-group"><p>latest antibot</p></div>`,
      );
      const button = column.querySelector<HTMLButtonElement>(".chat-history-boundary__action")!;
      let pages = 3;
      const clicks = vi.fn(() => {
        // A page loads: busy for a while, then the boundary goes away at the chat's start.
        button.setAttribute("aria-busy", "true");
        setTimeout(() => {
          pages -= 1;
          if (pages === 0) {
            button.parentElement!.remove();
          } else {
            button.setAttribute("aria-busy", "false");
          }
        }, 1_000);
      });
      button.addEventListener("click", clicks);
      const { view, count } = mountSearch(column, "antibot");
      await vi.advanceTimersByTimeAsync(10_000);
      expect(clicks).toHaveBeenCalledTimes(3);
      expect(column.querySelector(".chat-history-boundary__action")).toBeNull();
      expect(count()).toBe("1 / 1");
      view.unmount();
      column.remove();
    } finally {
      vi.useRealTimers();
    }
  });
});
