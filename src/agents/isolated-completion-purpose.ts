/** Bounded internal diagnostic labels, independent of execution policy triggers. */
export type IsolatedCompletionPurpose =
  | "isolated-completion"
  | "session-activity-summary"
  | "session-observer"
  | "conversation-label"
  | "composer-prediction"
  | "progress-narration"
  | "transcript-summary"
  | "skill-diet"
  | "plugin-completion"
  // Fork (N15): Forget a topic rewrites commit and pull request paragraphs with a local model.
  | "forget-rewrite";
