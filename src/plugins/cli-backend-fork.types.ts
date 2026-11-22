// Fork: what the fork adds to the CLI backend contract, kept out of cli-backend.types.ts so
// upstream ports touch less. Each upstream type there intersects its `...Fork` part here.

export type CliBackendConfigFork = {
  /**
   * Fork (F72): also reseed history and carry unseen turns when the history boundary
   * cannot name the account (a CLI-native login without an OpenClaw credential).
   * Intended for single-owner installs; off by default.
   */
  historyAllowUnknownAuth?: boolean;
  /**
   * Fork: how long an idle reusable process stays alive between turns (ms). A chat keeps one
   * process, and with it one Claude in Chrome tab group, as long as it is not idle longer.
   */
  liveSessionIdleMs?: number;
  /**
   * Fork (F72): how many unseen turns a resumed session receives (default 8). When set,
   * the newest turns are also kept within the reseed history character budget.
   */
  maxUnseenTurns?: number;
};

export type CliBackendToolPermissionRequestFork = {
  /**
   * Fork (F49): the session's native permission mode asks the operator for this action even
   * when host policy would allow it silently. Host denials and standing grants still apply.
   */
  requireApproval?: boolean;
};

export type CliBackendLiveSessionHandleFork = {
  /**
   * Fork (F47): stops one background task of this process (Claude CLI `stop_task`).
   * Resolves false when the process does not know the task or cannot take input.
   */
  stopTask?(taskId: string): Promise<boolean>;
  /**
   * Fork (F52): restores files the native runtime edited since one of its user messages
   * (Claude CLI `rewind_files`); `dryRun` only reports what would change. Resolves undefined
   * when the process cannot take the request (closed or running a turn).
   */
  rewindFiles?(
    userMessageId: string,
    options: { dryRun: boolean },
  ): Promise<CliBackendRewindFilesResult | undefined>;
};

/** Fork (F52): the native answer to a file rewind, as Claude CLI reports it. */
export type CliBackendRewindFilesResult = {
  canRewind: boolean;
  error?: string;
  filesChanged?: string[];
  insertions?: number;
  deletions?: number;
  /** Files a real rewind left alone because of links or unreadable backups. */
  skippedLinks?: number;
};

export type CliBackendLiveSessionCapabilityFork = {
  /** Fork: the backend's configured idle lifetime of the process (`liveSessionIdleMs`). */
  idleTimeoutMs?: number;
};

export type CliBackendExecuteContextFork = {
  /**
   * Reports the backend's predicted next user prompt for this session. Native
   * runtimes emit it after the turn's result, so it stays callable after the run closes.
   */
  onPromptSuggestion?: (text: string) => void;
  /**
   * Fork (F49): the session's explicit native permission mode (Claude CLI `--permission-mode`).
   * Absent keeps the backend's established behavior.
   */
  permissionMode?: string;
  /** Fork (F49): records a mode the operator chose during the run (plan approval) on the session. */
  onPermissionModeChange?: (mode: string) => Promise<void>;
};

export type CliBackendPluginBaseFork = {
  /**
   * Fork (C10): native tools that only keep state local to the CLI run, such as a
   * todo list, kept on the same managed turns as `resolveManagedNativeTools`. They
   * confer no capability, file access, or delegation, and need no operator selection.
   */
  managedLocalStateTools?: readonly string[];
};
