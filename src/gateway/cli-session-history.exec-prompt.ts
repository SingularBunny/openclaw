import { EXEC_TIMEOUT_RETRY_GUIDANCE } from "../agents/bash-tools.exec-output.js";
import { stripCliPromptDecorations } from "./cli-session-history.prompt-text.js";

// Fork: a background exec completion is sent to Claude as its bare event text, one line per
// finished command (see bash-tools.exec-notify.ts): `Exec <status> (<id>, <exit>)` and an
// optional ` :: <output tail>`; timeouts append retry guidance after a blank line.
const EXEC_COMPLETION_LINE =
  /^Exec (?:completed|failed) \([^\s(),]{1,8}, (?:code -?\d+|signal [A-Z0-9]+|unknown exit code)\)(?: :: [^\n]*)?$/u;

export function isClaudeCliExecCompletionPrompt(text: string): boolean {
  // Gap and resume notes can come in either order ahead of the notices.
  let body = text;
  for (let pass = 0; pass < 3; pass += 1) {
    const stripped = stripCliPromptDecorations(body);
    if (stripped === body) {
      break;
    }
    body = stripped;
  }
  const lines = body.split("\n").filter((line) => line.trim() !== "");
  return (
    lines.length > 0 &&
    EXEC_COMPLETION_LINE.test(lines[0]!) &&
    lines.every((line) => EXEC_COMPLETION_LINE.test(line) || line === EXEC_TIMEOUT_RETRY_GUIDANCE)
  );
}
