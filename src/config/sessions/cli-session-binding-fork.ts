// Fork: native CLI resume points recorded on assistant replies, used by rewind, edit, branch switch and
// message fork. Kept out of cli-session-binding.ts so upstream changes there merge without conflicts.
import { createHash } from "node:crypto";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { getCliSessionBinding } from "./cli-session-binding.js";
import type { CliSessionBinding, SessionEntry } from "./types.js";

const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;

type CliSessionBindingEntry = Pick<SessionEntry, "cliSessionBindings" | "cliSessionIds">;

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
