export const DEFAULT_WORKER_PENDING_TASKS = 128;
export const DEFAULT_WORKER_PENDING_BYTES = 256 * 1024 * 1024;
export const DEFAULT_WORKER_HEAP_MB = 512;

// Memory indexing of very large chats (tens of thousands of messages) overflows these defaults
// ("worker task capacity reached", reader heaps). OPENCLAW_WORKER_PENDING_TASKS,
// OPENCLAW_WORKER_PENDING_BYTES and OPENCLAW_WORKER_HEAP_MB replace them. Read on use rather than
// on import, so a state-dir .env loaded after the modules still applies.
function envLimit(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export function workerPendingTasksLimit(): number {
  return envLimit("OPENCLAW_WORKER_PENDING_TASKS", DEFAULT_WORKER_PENDING_TASKS);
}

export function workerPendingBytesLimit(): number {
  return envLimit("OPENCLAW_WORKER_PENDING_BYTES", DEFAULT_WORKER_PENDING_BYTES);
}

/** Old-generation heap ceiling of state, transcript and SQLite workers. */
export function workerHeapLimitMb(): number {
  return envLimit("OPENCLAW_WORKER_HEAP_MB", DEFAULT_WORKER_HEAP_MB);
}

export type WorkerComputePermit = { requestCheckpoint: () => boolean };

/** Shared compute admission; database and generation workers keep their own ordering. */
export function createWorkerComputeCapacity(limit: number) {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError("compute capacity must be a positive safe integer");
  }
  const active = new Set<WorkerComputePermit>();
  const waiting = new Set<() => void>();
  let pendingTasks = 0;
  let pendingBytes = 0;
  let draining = false;
  const requestCheckpoints = () => {
    let demand = waiting.size;
    if (demand) {
      for (const permit of active) {
        if (permit.requestCheckpoint() && --demand === 0) {
          break;
        }
      }
    }
  };
  const drain = () => {
    if (draining) {
      return;
    }
    draining = true;
    try {
      while (active.size < limit && waiting.size) {
        const next = waiting.values().next().value!;
        waiting.delete(next);
        next();
      }
    } finally {
      draining = false;
    }
    requestCheckpoints();
  };
  return {
    getSnapshot: () => ({
      limit,
      active: active.size,
      waitingPools: waiting.size,
      pendingTasks,
      pendingBytes,
    }),
    admit(bytes: number): boolean {
      if (
        pendingTasks >= workerPendingTasksLimit() ||
        pendingBytes + bytes > workerPendingBytesLimit()
      ) {
        return false;
      }
      pendingTasks++;
      pendingBytes += bytes;
      return true;
    },
    finish(bytes: number) {
      pendingTasks--;
      pendingBytes -= bytes;
    },
    acquire(resume: () => void, requestCheckpoint: () => boolean): WorkerComputePermit | undefined {
      // A newly submitting pool must not overtake an already waiting pool.
      if (active.size >= limit || (!draining && waiting.size)) {
        waiting.add(resume);
        requestCheckpoints();
        return undefined;
      }
      const permit = { requestCheckpoint };
      active.add(permit);
      return permit;
    },
    release(permit: WorkerComputePermit) {
      active.delete(permit);
      drain();
    },
    remove(resume: () => void) {
      waiting.delete(resume);
    },
    requestCheckpoints,
  };
}

export type WorkerComputeCapacity = ReturnType<typeof createWorkerComputeCapacity>;
