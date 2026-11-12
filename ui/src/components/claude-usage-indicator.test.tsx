/* @vitest-environment jsdom */
import { flush } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import type { UsageSummary } from "../../../src/infra/provider-usage.types.js";
import type { ApplicationGateway } from "../app/gateway.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { CLAUDE_USAGE_POLL_MS, ClaudeUsageIndicator } from "./claude-usage-indicator.tsx";

afterEach(() => vi.useRealTimers());

function fakeGateway(responses: UsageSummary[]) {
  const request = vi.fn(async () => responses.shift() ?? { updatedAt: 0, providers: [] });
  let emit: ((event: { event: string; payload?: unknown }) => void) | undefined;
  const gateway = {
    snapshot: {
      phase: "connected",
      client: { request },
      hello: {
        features: { methods: ["usage.status"] },
        auth: { role: "operator", scopes: ["operator.read"] },
      },
    },
    subscribe: () => () => {},
    subscribeEvents: (listener: typeof emit) => {
      emit = listener;
      return () => {};
    },
  } as unknown as ApplicationGateway;
  return { gateway, request, emit: (event: { event: string; payload?: unknown }) => emit?.(event) };
}

const claude = (usedPercent: number, extra: Partial<UsageSummary["providers"][number]> = {}) => ({
  updatedAt: Date.now(),
  providers: [
    {
      provider: "anthropic",
      displayName: "Claude",
      windows: [{ label: "5h", usedPercent, resetAt: Date.now() + 90 * 60_000 }],
      ...extra,
    },
  ],
});

it("does not call a Gateway that does not advertise usage.status", async () => {
  const { gateway, request } = fakeGateway([claude(30)]);
  (gateway.snapshot as { hello: unknown }).hello = { features: { methods: [] } };
  const view = mountSolid(() => <ClaudeUsageIndicator gateway={() => gateway} />);
  await Promise.resolve();
  expect(request).not.toHaveBeenCalled();
  expect(view.container.querySelector(".claude-usage")).toBeNull();
  view.unmount();
});

// Fork: F43 — Claude subscription limits stay visible in the sidebar.
it("renders bars from usage.status, polls, and re-reads after a turn ends", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse("2026-11-10T12:00:00Z"));
  const { gateway, request, emit } = fakeGateway([
    { updatedAt: 0, providers: [] },
    claude(30),
    claude(30, {
      rateLimit: { status: "rejected", limitType: "five_hour", observedAt: Date.now() },
    }),
  ]);
  const view = mountSolid(() => <ClaudeUsageIndicator gateway={() => gateway} />);
  await vi.advanceTimersByTimeAsync(0);
  flush();
  // An empty summary keeps the indicator hidden.
  expect(view.container.querySelector(".claude-usage")).toBeNull();

  await vi.advanceTimersByTimeAsync(CLAUDE_USAGE_POLL_MS);
  flush();
  const row = view.container.querySelector(".claude-usage__row");
  expect(row?.textContent).toContain("30%");
  // Reset 90 minutes after the fixture was built, read 30 seconds later.
  expect(row?.textContent).toContain("1h 29m");
  expect(row?.getAttribute("title")).toMatch(/^Resets /);

  emit({ event: "chat", payload: { state: "final" } });
  await vi.advanceTimersByTimeAsync(2_000);
  flush();
  expect(request).toHaveBeenCalledTimes(3);
  expect(view.container.querySelector(".claude-usage__status")?.textContent).toContain(
    "5h limit reached",
  );
  expect(view.container.querySelector(".claude-usage__row--danger")).not.toBeNull();
  view.unmount();
});

// Fork (V1): other providers' limits show as their own blocks after Claude.
it("renders a block per provider with usage windows, Claude first", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse("2026-11-10T12:00:00Z"));
  const summary = claude(30);
  summary.providers.unshift({
    provider: "openai",
    displayName: "OpenAI",
    windows: [{ label: "Week", usedPercent: 80, resetAt: Date.now() + 90 * 60_000 }],
  });
  const { gateway } = fakeGateway([summary]);
  const view = mountSolid(() => <ClaudeUsageIndicator gateway={() => gateway} />);
  await vi.advanceTimersByTimeAsync(0);
  flush();
  const blocks = [...view.container.querySelectorAll(".claude-usage")];
  expect(blocks.map((block) => block.getAttribute("data-provider"))).toEqual([
    "anthropic",
    "openai",
  ]);
  expect(blocks[1]?.querySelector(".claude-usage__title")?.textContent).toBe("OpenAI usage");
  expect(blocks[1]?.querySelector(".claude-usage__row--warn")?.textContent).toContain("80%");
  view.unmount();
});
