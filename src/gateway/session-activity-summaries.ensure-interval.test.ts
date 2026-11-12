import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as utilityCompletion from "../agents/utility-completion.js";
import { loadSessionEntryReadOnly } from "../config/sessions/session-accessor.entry.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import type { OpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { RecapEnsureTarget } from "./session-activity-recap-ensure.js";
import {
  createSessionActivitySummaries,
  type SessionActivitySummaryService,
} from "./session-activity-summaries.js";
import {
  activityRecapResult,
  createActivityRecapSessionFixture,
  messages,
  preparedActivityRecapModel,
  scope,
  target,
} from "./session-activity-summaries.test-support.js";
import type { defaultCompleteModel } from "./session-observer-model.js";
import * as observerModel from "./session-observer-model.js";

// Fork (F41): opening the Activity page must not recap every stale session at once after a
// Gateway restart; page requests keep OPENCLAW_ACTIVITY_RECAP_MIN_INTERVAL_MS, Retry does not.

const INTERVAL_MS = 600_000;
const recap = "Verified the change.";
const complete = vi.fn<typeof defaultCompleteModel>();
const changed = vi.fn();
const time = createGatewaySchedulerClock(Date.now());
let testState: OpenClawTestState;
let cfg: OpenClawConfig;
let scheduler: GatewayScheduler;
let service: SessionActivitySummaryService;
let previousInterval: string | undefined;

const startService = () => {
  scheduler = createTestGatewayScheduler(time.clock);
  service = createSessionActivitySummaries({
    scheduler,
    getConfig: () => cfg,
    onChanged: changed,
  });
};
const restart = async () => {
  await service.dispose();
  await scheduler.stop();
  startService();
};
const ensure = async (request: RecapEnsureTarget) => {
  const work = new AsyncWorkScope();
  const view = await work.track(() => service.ensure(request, loadSessionEntryReadOnly(scope)));
  await work.drain();
  return view;
};

describe("Activity recap ensure interval", () => {
  beforeEach(async () => {
    previousInterval = process.env.OPENCLAW_ACTIVITY_RECAP_MIN_INTERVAL_MS;
    process.env.OPENCLAW_ACTIVITY_RECAP_MIN_INTERVAL_MS = String(INTERVAL_MS);
    cfg = { agents: { defaults: { utilityModel: "test/utility" } } };
    testState = await createActivityRecapSessionFixture(cfg);
    complete.mockReset().mockResolvedValue(activityRecapResult(recap));
    vi.spyOn(utilityCompletion, "hasAvailableUtilityCompletionAuth").mockResolvedValue(true);
    vi.spyOn(observerModel, "defaultPrepareModel").mockResolvedValue(preparedActivityRecapModel);
    vi.spyOn(observerModel, "defaultCompleteModel").mockImplementation(complete);
    changed.mockReset();
    startService();
    await messages(1);
    await ensure(target);
    expect(complete).toHaveBeenCalledTimes(1);
    await messages(1, 1);
  });
  afterEach(async () => {
    await service.dispose();
    await scheduler.stop();
    await testState.cleanup();
    vi.restoreAllMocks();
    if (previousInterval === undefined) {
      delete process.env.OPENCLAW_ACTIVITY_RECAP_MIN_INTERVAL_MS;
    } else {
      process.env.OPENCLAW_ACTIVITY_RECAP_MIN_INTERVAL_MS = previousInterval;
    }
  });

  it("serves the stored recap after a restart until the interval passes; Retry starts at once", async () => {
    const recapAt = loadSessionEntryReadOnly(scope)!.activitySummary!.updatedAt;
    await restart();
    await time.advanceBy(60_000);

    const served = await ensure({ ...target, immediate: false });
    expect(served.text).toBe(recap);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(time.armedAtMs).toBe(recapAt + INTERVAL_MS);

    await ensure({ ...target, immediate: true });
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("recaps a page request at once when the stored recap is older than the interval", async () => {
    await restart();
    await time.advanceBy(INTERVAL_MS + 1);

    await ensure({ ...target, immediate: false });
    expect(complete).toHaveBeenCalledTimes(2);
  });
});
