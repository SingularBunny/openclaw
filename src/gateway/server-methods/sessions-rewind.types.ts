import type { SessionMessageCutResult } from "../../config/sessions/session-message-cut.types.js";

// Message-cut types of sessions-rewind.ts, kept apart so that handler stays within its size limit.
export type MessageCutAction = "fork" | "rewind" | "switch";
export type MessageCutMutationResult = SessionMessageCutResult;
