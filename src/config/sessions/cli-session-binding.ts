// CLI session binding lookup shared by session lifecycle and agent runtime code.
import { createHash } from "node:crypto";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { CliSessionBinding, CliSessionReseedReceipt, SessionEntry } from "./types.js";

const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;
type CliSessionBindingEntry = Pick<SessionEntry, "cliSessionBindings" | "cliSessionIds">;

export function normalizeCliTranscriptCursor(value: CliSessionBinding["transcriptCursor"]) {
  const localSessionId = normalizeOptionalString(value?.localSessionId);
  const runId = normalizeOptionalString(value?.runId);
  const entryId = value?.entryId === null ? null : normalizeOptionalString(value?.entryId);
  return localSessionId && runId && entryId !== undefined
    ? { localSessionId, entryId, runId, userEntryId: normalizeOptionalString(value?.userEntryId) }
    : undefined;
}

export function normalizeCliSessionReseedReceipt(
  value: CliSessionReseedReceipt | undefined,
): CliSessionReseedReceipt | undefined {
  const promptHash = normalizeOptionalString(value?.promptHash);
  const localSessionId = normalizeOptionalString(value?.localSessionId);
  const userTurnDisposition = value?.userTurnDisposition;
  if (
    value?.version !== 1 ||
    !promptHash ||
    !SHA256_HEX_PATTERN.test(promptHash) ||
    !localSessionId ||
    (userTurnDisposition !== "persisted" && userTurnDisposition !== "omitted")
  ) {
    return undefined;
  }
  return {
    version: 1,
    promptHash,
    localSessionId,
    userTurnDisposition,
  };
}

/**
 * Re-own omitted reseed receipts when a reset intentionally preserves the
 * native CLI conversation. Persisted turns keep their old owner and fail open
 * because their canonical user row belongs to the archived local transcript.
 */
export function rebindCliSessionReseedReceiptsForReset(
  bindings: Record<string, CliSessionBinding> | undefined,
  localSessionId: string,
): Record<string, CliSessionBinding> | undefined {
  const normalizedLocalSessionId = normalizeOptionalString(localSessionId);
  if (!bindings || !normalizedLocalSessionId) {
    return bindings;
  }

  let rebound: Record<string, CliSessionBinding> | undefined;
  for (const [provider, binding] of Object.entries(bindings)) {
    const receipt = normalizeCliSessionReseedReceipt(binding.reseedReceipt);
    if (!receipt || receipt.userTurnDisposition !== "omitted") {
      continue;
    }
    rebound ??= { ...bindings };
    rebound[provider] = {
      ...binding,
      reseedReceipt: {
        ...receipt,
        localSessionId: normalizedLocalSessionId,
      },
    };
  }
  return rebound ?? bindings;
}

/** Read the stored provider-keyed CLI session binding. */
export function getCliSessionBinding(
  entry: CliSessionBindingEntry | undefined,
  provider: string,
): CliSessionBinding | undefined {
  if (!entry) {
    return undefined;
  }
  const normalized = normalizeProviderId(provider);
  const fromBindings = entry.cliSessionBindings?.[normalized];
  const bindingSessionId = normalizeOptionalString(fromBindings?.sessionId);
  if (bindingSessionId) {
    return {
      sessionId: bindingSessionId,
      resumeCheckpointId: normalizeOptionalString(fromBindings?.resumeCheckpointId),
      ...(fromBindings?.forceReuse === true ? { forceReuse: true } : {}),
      ...(fromBindings?.forkNextResume === true ? { forkNextResume: true } : {}),
      authProfileId: normalizeOptionalString(fromBindings?.authProfileId),
      authEpoch: normalizeOptionalString(fromBindings?.authEpoch),
      authEpochVersion: fromBindings?.authEpochVersion,
      extraSystemPromptHash: normalizeOptionalString(fromBindings?.extraSystemPromptHash),
      messageToolPolicyHash: normalizeOptionalString(fromBindings?.messageToolPolicyHash),
      promptToolNamesHash: normalizeOptionalString(fromBindings?.promptToolNamesHash),
      cwdHash: normalizeOptionalString(fromBindings?.cwdHash),
      mcpConfigHash: normalizeOptionalString(fromBindings?.mcpConfigHash),
      mcpResumeHash: normalizeOptionalString(fromBindings?.mcpResumeHash),
      reseedReceipt: normalizeCliSessionReseedReceipt(fromBindings?.reseedReceipt),
      transcriptCursor: normalizeCliTranscriptCursor(fromBindings?.transcriptCursor),
    };
  }
  const fromMap = entry.cliSessionIds?.[normalized];
  const normalizedFromMap = normalizeOptionalString(fromMap);
  if (normalizedFromMap) {
    return { sessionId: normalizedFromMap };
  }
  return undefined;
}

// A copied binding must branch at the recorded checkpoint even if the parent advances.
// Retain account/environment validation; force-reuse and reseed receipts belong to the parent.
export function forkCliSessionBindings(
  parent: CliSessionBindingEntry | undefined,
  supportsFork: (provider: string) => boolean,
): Record<string, CliSessionBinding> | undefined {
  const providers = new Set([
    ...Object.keys(parent?.cliSessionBindings ?? {}),
    ...Object.keys(parent?.cliSessionIds ?? {}),
  ]);
  const forked: Record<string, CliSessionBinding> = {};
  for (const provider of providers) {
    const binding = getCliSessionBinding(parent, provider);
    if (binding?.resumeCheckpointId && supportsFork(provider)) {
      const {
        reseedReceipt: _reseedReceipt,
        transcriptCursor: _transcriptCursor,
        forceReuse: _forceReuse,
        ...inherited
      } = binding;
      forked[normalizeProviderId(provider)] = { ...inherited, forkNextResume: true };
    }
  }
  return Object.keys(forked).length > 0 ? forked : undefined;
}

/** Native resume point recorded on an assistant transcript message as `__openclaw.cliResume`. */
export type CliSessionResumePoint = {
  provider: string;
  sessionId: string;
  /** Backend checkpoint accepted by `resumeAtArg` (the Claude assistant message uuid). */
  checkpointId: string;
  /** Account/workspace digest of the binding that produced this point; see below. */
  compat?: string;
  /**
   * Fork (F52): native id of the user message that started this reply's turn. Claude keys its
   * file checkpoints by it, so a rewind before that message can restore the files.
   */
  inputMessageId?: string;
};

export const CLI_SESSION_RESUME_POINT_KEY = "cliResume";

/**
 * Digest of the account and workspace a native session belongs to. A resume point from an
 * older native session is only reused when this matches the current binding, so a history cut
 * cannot move a native session across accounts or workspaces. Inputs are already fingerprints.
 */
export function hashCliSessionResumeCompat(
  binding: Pick<CliSessionBinding, "authProfileId" | "authEpoch" | "authEpochVersion" | "cwdHash">,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        "cli-resume-compat-v1",
        normalizeOptionalString(binding.authProfileId) ?? null,
        normalizeOptionalString(binding.authEpoch) ?? null,
        typeof binding.authEpochVersion === "number" ? binding.authEpochVersion : null,
        normalizeOptionalString(binding.cwdHash) ?? null,
      ]),
    )
    .digest("hex");
}

export function readCliSessionResumePoint(message: unknown): CliSessionResumePoint | undefined {
  const record = isRecord(message) ? message : undefined;
  const metadata = isRecord(record?.["__openclaw"]) ? record["__openclaw"] : undefined;
  const point = isRecord(metadata?.[CLI_SESSION_RESUME_POINT_KEY])
    ? metadata[CLI_SESSION_RESUME_POINT_KEY]
    : undefined;
  const provider = normalizeOptionalString(point?.provider);
  const sessionId = normalizeOptionalString(point?.sessionId);
  const checkpointId = normalizeOptionalString(point?.checkpointId);
  if (!provider || !sessionId || !checkpointId) {
    return undefined;
  }
  const compat = normalizeOptionalString(point?.compat);
  const inputMessageId = normalizeOptionalString(point?.inputMessageId);
  return {
    provider: normalizeProviderId(provider),
    sessionId,
    checkpointId,
    ...(compat && SHA256_HEX_PATTERN.test(compat) ? { compat } : {}),
    ...(inputMessageId ? { inputMessageId } : {}),
  };
}

/**
 * Re-arm a native CLI binding at an earlier point of the same chat (rewind, edit, branch switch,
 * message fork). The next turn resumes the recorded session at the checkpoint with the backend's
 * fork argument, then keeps the forked successor. The restored binding keeps the current
 * binding's validation fingerprints, so the ordinary reuse checks still run before resume.
 * Returns undefined (fresh native session) when no compatible checkpoint is known.
 */
export function resumeCliSessionBindingsAt(
  current: CliSessionBindingEntry | undefined,
  point: CliSessionResumePoint | undefined,
  supportsFork: (provider: string) => boolean,
): Record<string, CliSessionBinding> | undefined {
  if (!point || !supportsFork(point.provider)) {
    return undefined;
  }
  const binding = getCliSessionBinding(current, point.provider);
  if (!binding) {
    return undefined;
  }
  const sameSession = binding.sessionId === point.sessionId;
  if (!sameSession && point.compat !== hashCliSessionResumeCompat(binding)) {
    return undefined;
  }
  const {
    reseedReceipt: _reseedReceipt,
    forceReuse,
    resumeCheckpointId: _resumeCheckpointId,
    forkNextResume: _forkNextResume,
    ...inherited
  } = binding;
  const resumed: CliSessionBinding = {
    ...inherited,
    sessionId: point.sessionId,
    resumeCheckpointId: point.checkpointId,
    // An explicit attachment covers only the attached native session itself.
    ...(sameSession && forceReuse === true ? { forceReuse: true } : {}),
    forkNextResume: true,
  };
  return { [point.provider]: resumed };
}

export function clearAllCliSessions(
  entry: Partial<Pick<SessionEntry, "cliSessionBindings" | "cliSessionIds" | "claudeCliSessionId">>,
): void {
  entry.cliSessionBindings = undefined;
  entry.cliSessionIds = undefined;
  entry.claudeCliSessionId = undefined;
}
