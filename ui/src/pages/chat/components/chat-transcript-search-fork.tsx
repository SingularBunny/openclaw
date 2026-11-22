// Fork: transcript search over the whole chat, with highlighted matches.
// Upstream search filters the loaded messages only and marks nothing. Here, while a query is open,
// the search presses the transcript's own "Show earlier" until the chat's start (at most
// SEARCH_HISTORY_PAGE_LIMIT times), and the matches are highlighted in the
// rendered messages (CSS Custom Highlight API: no DOM is changed) with "3 / 12", ↑ ↓, Enter and
// Shift+Enter moving between them, as a browser's find bar does.
import { createEffect, createSignal, onCleanup } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { t } from "../../../lib/reactive/i18n.ts";
import type { TranscriptSearchState } from "./chat-transcript-search-state.ts";
import "./chat-transcript-search-fork.css";

/** "Show earlier" presses for one query at most; a guard against a cursor that never ends. */
export const SEARCH_HISTORY_PAGE_LIMIT = 500;
const HISTORY_POLL_MS = 300;
const HIGHLIGHT = "openclaw-search";
const CURRENT = "openclaw-search-current";

const normalize = (value: string) => value.normalize("NFC").toLocaleLowerCase();

const SKIP = ".agent-chat__search-bar, button, input, textarea, [contenteditable], script, style";

/** Text ranges of the query in the transcript under `root` (case-insensitive). */
export function findTranscriptMatches(root: Element, query: string): Range[] {
  const needle = normalize(query.trim());
  if (!needle) {
    return [];
  }
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.parentElement?.closest(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  const ranges: Range[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const value = node.nodeValue ?? "";
    // NFC keeps lengths for the composed text the transcript renders; lowercase may not, so
    // positions come from a per-character comparison window.
    const lower = normalize(value);
    if (lower.length !== value.length) {
      continue;
    }
    for (let at = lower.indexOf(needle); at >= 0; at = lower.indexOf(needle, at + needle.length)) {
      const range = root.ownerDocument.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + needle.length);
      ranges.push(range);
    }
  }
  return ranges;
}

type HighlightRegistry = {
  set(name: string, highlight: unknown): void;
  delete(name: string): void;
};

function highlights(): { registry: HighlightRegistry; make: (ranges: Range[]) => unknown } | null {
  const registry = (globalThis.CSS as { highlights?: HighlightRegistry } | undefined)?.highlights;
  const Make = (globalThis as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
  return registry && Make ? { registry, make: (ranges) => new Make(...ranges) } : null;
}

/** "3 / 12", ↑ ↓ and the history status, next to the search input. */
export function TranscriptSearchMatches(props: {
  search: TranscriptSearchState;
  query: string;
  input: () => HTMLInputElement | undefined;
}) {
  const [loading, setLoading] = createSignal(false);
  const [count, setCount] = createSignal(0);
  const [current, setCurrent] = createSignal(0);
  let ranges: Range[] = [];
  // A new query starts at the newest match, where the reader is.
  let newest = true;
  const api = highlights();

  const root = () => props.input()?.closest(".chat-main__conversation-column") ?? null;
  const paint = (index: number, scroll: boolean) => {
    if (!api) {
      return;
    }
    api.registry.set(HIGHLIGHT, api.make(ranges));
    const range = ranges[index];
    if (range) {
      api.registry.set(CURRENT, api.make([range]));
      if (scroll) {
        range.startContainer.parentElement?.scrollIntoView({ block: "center", behavior: "smooth" });
      }
    } else {
      api.registry.delete(CURRENT);
    }
  };
  const refresh = (scroll: boolean) => {
    const container = root();
    ranges = container ? findTranscriptMatches(container, props.query) : [];
    setCount(ranges.length);
    const index = ranges.length
      ? newest
        ? ranges.length - 1
        : Math.min(current(), ranges.length - 1)
      : 0;
    if (ranges.length) {
      newest = false;
    }
    setCurrent(index);
    paint(index, scroll);
  };
  const move = (step: number) => {
    if (!ranges.length) {
      return;
    }
    const index = (current() + step + ranges.length) % ranges.length;
    setCurrent(index);
    paint(index, true);
  };

  // The whole chat: press the transcript's own "Show earlier" until it is gone (the chat's start).
  let historyRun = 0;
  const loadWholeChat = () => {
    const run = ++historyRun;
    let presses = 0;
    const step = () => {
      if (run !== historyRun || !props.query.trim()) {
        setLoading(false);
        return;
      }
      const button = root()?.querySelector<HTMLButtonElement>(".chat-history-boundary__action");
      if (!button || presses >= SEARCH_HISTORY_PAGE_LIMIT) {
        setLoading(false);
        return;
      }
      setLoading(true);
      if (
        button.getAttribute("aria-busy") !== "true" &&
        button.getAttribute("aria-disabled") !== "true"
      ) {
        presses += 1;
        button.click();
      }
      historyTimer = setTimeout(step, HISTORY_POLL_MS);
    };
    clearTimeout(historyTimer);
    step();
  };
  let historyTimer: ReturnType<typeof setTimeout> | undefined;

  createEffect(
    () => props.query,
    () => {
      newest = true;
      refresh(true);
      loadWholeChat();
    },
  );
  // The transcript re-renders as pages arrive and the filter applies; re-find without scrolling.
  let observer: MutationObserver | undefined;
  let frame = 0;
  queueMicrotask(() => {
    const container = root();
    if (!container || typeof MutationObserver !== "function") {
      return;
    }
    observer = new MutationObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => refresh(false));
    });
    observer.observe(container, { childList: true, subtree: true, characterData: true });
  });
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Enter" && !event.isComposing) {
      event.preventDefault();
      move(event.shiftKey ? -1 : 1);
    }
  };
  queueMicrotask(() => props.input()?.addEventListener("keydown", onKey));
  onCleanup(() => {
    historyRun += 1;
    clearTimeout(historyTimer);
    observer?.disconnect();
    cancelAnimationFrame(frame);
    props.input()?.removeEventListener("keydown", onKey);
    api?.registry.delete(HIGHLIGHT);
    api?.registry.delete(CURRENT);
  });

  return (
    <span class="agent-chat__search-matches" aria-live="polite">
      <span class="agent-chat__search-count">
        {loading()
          ? t("chat.thread.searchLoadingHistory")
          : props.query.trim()
            ? count()
              ? `${current() + 1} / ${count()}`
              : t("chat.thread.searchNoMatches")
            : ""}
      </span>
      <button
        class="btn btn--ghost"
        type="button"
        aria-label={t("chat.thread.searchPrevious")}
        disabled={count() === 0}
        onClick={() => move(-1)}
      >
        <Icon name="chevronUp" />
      </button>
      <button
        class="btn btn--ghost"
        type="button"
        aria-label={t("chat.thread.searchNext")}
        disabled={count() === 0}
        onClick={() => move(1)}
      >
        <Icon name="chevronDown" />
      </button>
    </span>
  );
}
