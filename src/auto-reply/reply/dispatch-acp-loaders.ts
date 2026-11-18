import { createLazyPromise } from "../../shared/lazy-promise.js";

// Lazy runtimes of dispatch-acp.ts, kept apart so that module stays within its size limit.
export const loadDispatchAcpManagerRuntime = createLazyPromise(
  () => import("./dispatch-acp-manager.runtime.js"),
);
export const loadDispatchAcpAuditRuntime = createLazyPromise(
  () => import("../../agents/command/acp-lifecycle.js"),
);

export const loadDispatchAcpTranscriptRuntime = createLazyPromise(
  () => import("./dispatch-acp-transcript.runtime.js"),
);
