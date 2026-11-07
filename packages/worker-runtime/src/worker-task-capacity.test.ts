import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createWorkerComputeCapacity,
  DEFAULT_WORKER_HEAP_MB,
  DEFAULT_WORKER_PENDING_BYTES,
  DEFAULT_WORKER_PENDING_TASKS,
  workerHeapLimitMb,
  workerPendingBytesLimit,
  workerPendingTasksLimit,
} from "./worker-task-capacity.js";

describe("worker limits from the environment", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("keeps the defaults without overrides or with invalid values", () => {
    expect(workerPendingTasksLimit()).toBe(DEFAULT_WORKER_PENDING_TASKS);
    expect(workerPendingBytesLimit()).toBe(DEFAULT_WORKER_PENDING_BYTES);
    expect(workerHeapLimitMb()).toBe(DEFAULT_WORKER_HEAP_MB);
    for (const value of ["", "0", "-1", "1.5", "lots"]) {
      vi.stubEnv("OPENCLAW_WORKER_PENDING_TASKS", value);
      expect(workerPendingTasksLimit()).toBe(DEFAULT_WORKER_PENDING_TASKS);
    }
  });

  it("reads overrides on use, after the module was loaded", () => {
    vi.stubEnv("OPENCLAW_WORKER_PENDING_TASKS", "4096");
    vi.stubEnv("OPENCLAW_WORKER_PENDING_BYTES", String(4 * 1024 * 1024 * 1024));
    vi.stubEnv("OPENCLAW_WORKER_HEAP_MB", "8192");
    expect(workerPendingTasksLimit()).toBe(4096);
    expect(workerPendingBytesLimit()).toBe(4 * 1024 * 1024 * 1024);
    expect(workerHeapLimitMb()).toBe(8192);
  });

  it("admits shared compute tasks up to the overridden limit", () => {
    vi.stubEnv("OPENCLAW_WORKER_PENDING_TASKS", "3");
    const capacity = createWorkerComputeCapacity(1);
    expect([1, 2, 3, 4].map(() => capacity.admit(1))).toEqual([true, true, true, false]);
  });
});
