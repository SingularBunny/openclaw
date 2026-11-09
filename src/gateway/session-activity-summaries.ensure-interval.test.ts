import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { ACTIVITY_SUMMARY_FORMAT_REVISION } from "../config/sessions/activity-summary.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  loadSessionEntryReadOnly,
  persistSessionTranscriptTurn,
  readSessionTranscriptWatermark,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { readSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { ensureRecapNow } from "./session-activity-recap-ensure.js";
import {
  createSessionActivitySummaries,
  type SessionActivitySummaryService,
} from "./session-activity-summaries.js";
import {
  projectSessionActivitySummary,
  type ActivitySummaryTarget,
} from "./session-activity-summary-state.js";
import type { defaultCompleteModel, defaultPrepareModel } from "./session-observer-model.js";

// Fork (F41): opening the Activity page must not recap every stale session at once after a
// Gateway restart; page requests keep OPENCLAW_ACTIVITY_RECAP_MIN_INTERVAL_MS, Retry does not.

const result = {
  text: "Verified the change.",
  provider: "test",
  model: "utility",
  owner: { kind: "harness" as const, id: "test" },
};
const scope = (target: ActivitySummaryTarget) => ({
  agentId: target.agentId,
  sessionKey: target.key,
  sessionId: target.key,
});

describe("ensureRecapNow", () => {
  const recap = (sessionId: string, updatedAt: number) =>
    ({
      sessionId,
      updatedAt,
      activitySummary: {
        version: 1,
        formatRevision: ACTIVITY_SUMMARY_FORMAT_REVISION,
        text: "Earlier work.",
        updatedAt,
        sessionId,
        generation: null,
        maxSeq: 1,
        leafEntryId: null,
        coveredMessages: 1,
        totalMessages: 1,
        omittedContent: false,
      },
    }) as SessionEntry;
  it("starts at once unless the request is throttled", () => {
    const state = { sessionId: "s", lastStartedAt: 0, entry: recap("s", 5) };
    expect(ensureRecapNow(state, {}, 10)).toBe(true);
    expect(ensureRecapNow(state, { immediate: true }, 10)).toBe(true);
    expect(state.lastStartedAt).toBe(0);
  });

  it("counts a throttled request from the stored recap of the same session", () => {
    const state = {
      sessionId: "s",
      lastStartedAt: 0,
      entry: undefined as SessionEntry | undefined,
    };
    expect(ensureRecapNow(state, { immediate: false }, 10)).toBe(false);
    expect(state.lastStartedAt).toBe(0);
    state.entry = recap("old", 9);
    ensureRecapNow(state, { immediate: false }, 10);
    expect(state.lastStartedAt).toBe(0);
    state.entry = recap("s", 7);
    ensureRecapNow(state, { immediate: false }, 10);
    expect(state.lastStartedAt).toBe(7);
    // A recap stamped in the future does not push the next one further than now.
    state.entry = recap("s", 99);
    ensureRecapNow(state, { immediate: false }, 10);
    expect(state.lastStartedAt).toBe(10);
  });
});

describe("Activity recap ensure interval", () => {
  let testState: OpenClawTestState;
  let service: SessionActivitySummaryService;
  let scheduler: GatewayScheduler;
  let cfg: OpenClawConfig;
  let previousInterval: string | undefined;
  const complete = vi.fn<typeof defaultCompleteModel>();
  const prepare: typeof defaultPrepareModel = async ({ agentId, modelRef }) => ({
    config: cfg,
    agentId,
    provider: "test",
    model: modelRef?.split("/")[1] ?? "utility",
    authProfileId: undefined,
    agentDir: "/tmp/unused",
    outputTextPolicy: "strict-visible",
    thinkLevel: "off",
  });
  const changed = vi.fn();
  const time = createGatewaySchedulerClock(Date.now());
  const target = { agentId: "main", key: "agent:main:recap-1" };
  const view = () =>
    projectSessionActivitySummary({
      ...target,
      cfg,
      entry: loadSessionEntryReadOnly(scope(target)),
      watermark: readSessionTranscriptWatermark(scope(target)),
    });
  const readEntry = () =>
    readSessionEntryReadOnlyInWorker({
      agentId: target.agentId,
      sessionKey: target.key,
      storePath: resolveSessionStorePathCore(cfg.session?.store, { agentId: target.agentId }),
    });
  const createService = () =>
    createSessionActivitySummaries({
      scheduler,
      getConfig: () => cfg,
      onChanged: changed,
      prepareModel: prepare,
      completeModel: complete,
    });

  beforeEach(async () => {
    testState = await createOpenClawTestState({ scenario: "minimal" });
    cfg = { agents: { defaults: { utilityModel: "test/utility" } } };
    setRuntimeConfigSnapshot(cfg);
    complete.mockReset().mockResolvedValue(result);
    changed.mockReset();
    scheduler = createTestGatewayScheduler(time.clock);
    service = createService();
    previousInterval = process.env.OPENCLAW_ACTIVITY_RECAP_MIN_INTERVAL_MS;
    process.env.OPENCLAW_ACTIVITY_RECAP_MIN_INTERVAL_MS = "600000";
    await upsertSessionEntryCore(scope(target), { sessionId: target.key, updatedAt: 1 });
    await persistSessionTranscriptTurn(scope(target), {
      messages: [{ eventId: "message-1", message: { role: "user", content: "Request 1" } }],
      touchSessionEntry: false,
    });
  });
  afterEach(async () => {
    if (previousInterval === undefined) {
      delete process.env.OPENCLAW_ACTIVITY_RECAP_MIN_INTERVAL_MS;
    } else {
      process.env.OPENCLAW_ACTIVITY_RECAP_MIN_INTERVAL_MS = previousInterval;
    }
    await service.dispose();
    await scheduler.stop();
    await testState.cleanup();
  });

  it("serves the stored recap after a restart and waits the interval; Retry starts at once", async () => {
    const initial = createDeferred();
    changed.mockImplementation(() => {
      if (view()?.state === "current") {
        initial.resolve();
      }
    });
    await service.ensure(target, await readEntry());
    await initial.promise;
    expect(complete).toHaveBeenCalledTimes(1);
    const recapAt = time.clock.now();
    await persistSessionTranscriptTurn(scope(target), {
      messages: [
        {
          eventId: "new-work",
          parentId: "message-1",
          message: { role: "assistant", content: "Verified additional work." },
        },
      ],
      touchSessionEntry: false,
    });

    // A Gateway restart: a fresh service knows no last recap start.
    await service.dispose();
    service = createService();
    await time.advanceBy(60_000);
    const entry = await readEntry();
    const served = await service.ensure({ ...target, immediate: false }, entry);
    expect(served.text).toBe(result.text);
    expect(time.armedAtMs).toBe(recapAt + 600_000);
    await Promise.resolve();
    expect(complete).toHaveBeenCalledTimes(1);

    const retried = createDeferred();
    complete.mockImplementationOnce(async () => {
      retried.resolve();
      return result;
    });
    await service.ensure({ ...target, immediate: true }, entry);
    await retried.promise;
    expect(complete).toHaveBeenCalledTimes(2);
  });
});
