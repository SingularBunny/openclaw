import type {
  SessionBranchSwitchMutationResult,
  SessionMessageCutMutationResult,
} from "../../config/sessions/session-accessor.js";

// Message-cut types of sessions-rewind.ts, kept apart so that handler stays within its size limit.
export type MessageCutAction = "fork" | "rewind" | "switch";
export type MessageCutMutationResult =
  | SessionMessageCutMutationResult
  | SessionBranchSwitchMutationResult
  | { status: "conflict" };
