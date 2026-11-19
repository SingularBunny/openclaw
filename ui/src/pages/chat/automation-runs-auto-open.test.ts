import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  autoOpenAutomationRuns,
  resetAutomationRunsAutoOpenForTest,
} from "./automation-runs-auto-open.ts";

describe("automation chat opens its run history", () => {
  beforeEach(() => resetAutomationRunsAutoOpenForTest());

  it("opens Runs once per chat, after the render that asked for it", async () => {
    const open = vi.fn();
    autoOpenAutomationRuns("agent:ops:cron:job-1", open);
    expect(open).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(open).toHaveBeenCalledOnce();
    autoOpenAutomationRuns("agent:ops:cron:job-1", open);
    await Promise.resolve();
    expect(open).toHaveBeenCalledOnce();
    autoOpenAutomationRuns("agent:ops:cron:job-2", open);
    await Promise.resolve();
    expect(open).toHaveBeenCalledTimes(2);
  });
});
