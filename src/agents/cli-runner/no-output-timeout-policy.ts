import { type CliTimeoutContext, FailoverError } from "../failover-error.js";
import { createCliFailoverError } from "./exit-error.js";

type CliNoOutputTimeoutPolicyParams = {
  context: Pick<FailoverError, "provider" | "model" | "sessionId" | "lane">;
  cliTimeout: CliTimeoutContext;
  timeoutMs: number;
  quietDurationMs: number;
  hasOutputText: boolean;
  useResume: boolean;
  hasReplayUnsafeActivity: boolean;
  allowResumeControlOnlyRetry?: boolean;
  outstandingWorkGraceMs?: number;
  /** Fork (F36): silence allowed while the CLI waits for the model's first response byte. */
  modelRequestGraceMs?: number;
};

export const isReplaySafeCliResumeControlOnly = (useResume: boolean, ...unsafe: boolean[]) =>
  useResume && !unsafe.some(Boolean);
export function resolveCliNoOutputTimeoutDecision(params: CliNoOutputTimeoutPolicyParams): {
  deferMs?: number;
  error: FailoverError;
} {
  const toolWork = params.cliTimeout.activeToolCount + params.cliTimeout.backgroundTaskCount > 0;
  // Native compaction is silent but busy, so it is outstanding work like any blocked
  // call and inherits the same grace that work already holds on this path.
  const outstandingWork = toolWork || params.cliTimeout.compactionActive === true;
  // A pending model request is not tool work: it keeps its own, shorter grace and never
  // changes replay safety.
  const graces = [
    outstandingWork ? params.outstandingWorkGraceMs : undefined,
    params.modelRequestGraceMs,
  ].filter((value): value is number => value !== undefined);
  const deferMs =
    graces.length > 0 ? Math.max(params.timeoutMs, ...graces) - params.quietDurationMs : undefined;
  const retryable =
    (!params.cliTimeout.observedActivity && !params.hasOutputText) ||
    (params.allowResumeControlOnlyRetry === true &&
      isReplaySafeCliResumeControlOnly(
        params.useResume,
        params.hasOutputText,
        params.hasReplayUnsafeActivity,
        outstandingWork,
      ));
  return {
    ...(deferMs !== undefined && deferMs > 0 ? { deferMs } : {}),
    error: createCliTimeoutError(
      params.context,
      params.cliTimeout,
      retryable ? "cli_no_output_timeout" : undefined,
    ),
  };
}

export function createCliTimeoutError(
  context: Pick<FailoverError, "provider" | "model" | "sessionId" | "lane">,
  cliTimeout: CliTimeoutContext,
  code?: string,
): FailoverError {
  return createCliFailoverError(
    cliTimeout.mode === "no-output"
      ? `CLI produced no output for ${cliTimeout.timeoutSeconds}s and was terminated.`
      : `CLI exceeded timeout (${cliTimeout.timeoutSeconds}s) and was terminated.`,
    "timeout",
    context,
    { code, cliTimeout, timeout: { timeoutPhase: "provider" } },
  );
}
