// Fork (F55, I14): what the ai-workbench fork adds to a CLI assistant transcript row, kept out
// of cli-run-transcript.ts: the native resume checkpoint and the provider refusal marker.
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import {
  CLI_SESSION_RESUME_POINT_KEY,
  hashCliSessionResumeCompat,
  type CliSessionResumePoint,
} from "../../config/sessions/cli-session-binding.js";
import type { CliOutput } from "../cli-output-contracts.js";
import type { PreparedCliRunContext, RunCliAgentParams } from "./types.js";

/**
 * The native checkpoint a completed turn leaves behind. Recorded only when the turn's binding
 * will be kept and the backend can fork-resume at a checkpoint.
 */
export function resolveCliTranscriptResumePoint(params: {
  context: Pick<
    PreparedCliRunContext,
    "authEpoch" | "authEpochVersion" | "cwdHash" | "effectiveAuthProfileId" | "preparedBackend"
  > & { params: Pick<RunCliAgentParams, "provider"> };
  output: Pick<
    CliOutput,
    "resumeCheckpointId" | "inputMessageId" | "terminalInterruption" | "yielded"
  >;
  cliSessionId?: string;
  bindingKept: boolean;
}): CliSessionResumePoint | undefined {
  const { context, output } = params;
  const backend = context.preparedBackend.backend;
  const sessionId = params.cliSessionId?.trim();
  const checkpointId = output.resumeCheckpointId?.trim();
  const inputMessageId = output.inputMessageId?.trim();
  if (
    !params.bindingKept ||
    !sessionId ||
    !checkpointId ||
    output.terminalInterruption ||
    output.yielded ||
    backend.sessionMode === "none" ||
    !backend.forkArg ||
    !backend.resumeAtArg
  ) {
    return undefined;
  }
  return {
    provider: normalizeProviderId(context.params.provider),
    sessionId,
    checkpointId,
    compat: hashCliSessionResumeCompat({
      authProfileId: context.effectiveAuthProfileId,
      authEpoch: context.authEpoch,
      authEpochVersion: context.authEpochVersion,
      cwdHash: context.cwdHash,
    }),
    ...(inputMessageId ? { inputMessageId } : {}),
  };
}

/** The native identity, the refusal and the resume checkpoint share one metadata envelope. */
export function cliTranscriptMetadataEnvelope(params: {
  nativeIdentity?: Record<string, unknown>;
  resumePoint?: CliSessionResumePoint;
  refusal?: { category?: string };
}): { __openclaw?: Record<string, unknown> } {
  if (!params.nativeIdentity && !params.resumePoint && !params.refusal) {
    return {};
  }
  return {
    __openclaw: {
      ...(params.nativeIdentity ? { importedFrom: "claude-cli", ...params.nativeIdentity } : {}),
      ...(params.refusal ? { refusal: { signal: "provider", ...params.refusal } } : {}),
      ...(params.resumePoint ? { [CLI_SESSION_RESUME_POINT_KEY]: params.resumePoint } : {}),
    },
  };
}
