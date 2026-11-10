import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  PROGRESS_CARD_MAX_STEP_UTF8_BYTES,
  PROGRESS_CARD_MAX_STEPS,
  type ProgressCardStep,
} from "../../../packages/gateway-protocol/src/schema/progress-card.js";
import { truncateUtf8Prefix } from "../../utils/utf8-truncate.js";

/**
 * Fork (F45): Claude CLI's own todo list, read from its stream-json records.
 *
 * Two generations of tools carry it:
 * - `TodoWrite` `{ todos: [{ content, status, activeForm }] }` replaces the whole list.
 * - `TaskCreate` `{ subject, description, activeForm }` adds one task; its id arrives in
 *   the result (`tool_use_result.task.id`, or the text "Task #N created successfully").
 *   `TaskUpdate` `{ taskId, status?, subject? }` changes one task (`status: "deleted"`
 *   removes it). `TaskList` returns the whole list (`tool_use_result.tasks`, or text
 *   lines "#N [status] subject").
 *
 * Only main-thread calls count: records of a subagent carry `parent_tool_use_id`.
 * Changes apply on a successful tool result, so refused or failed calls never show.
 */
export type ClaudeTodoStatus = ProgressCardStep["status"];

type ClaudeTodoItem = { id?: string; text: string; status: ClaudeTodoStatus };

type ClaudeTodoState = { items: ClaudeTodoItem[]; touched: boolean };

const TODO_TOOL_NAMES = new Set(["TodoWrite", "TaskCreate", "TaskUpdate", "TaskList"]);
const MAX_TRACKED_SESSIONS = 64;
const MAX_PENDING_CALLS = 64;

// The task list belongs to the CLI session and outlives one turn; keep it per session.
const sessionStates = new Map<string, ClaudeTodoState>();

function readSessionState(key: string): ClaudeTodoState {
  const existing = sessionStates.get(key);
  if (existing) {
    // Refresh recency for the bounded map.
    sessionStates.delete(key);
    sessionStates.set(key, existing);
    return existing;
  }
  const created: ClaudeTodoState = { items: [], touched: false };
  sessionStates.set(key, created);
  while (sessionStates.size > MAX_TRACKED_SESSIONS) {
    const oldest = sessionStates.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    sessionStates.delete(oldest);
  }
  return created;
}

/** Test seam: forget every remembered session list. */
export function resetClaudeTodoSessionsForTest(): void {
  sessionStates.clear();
}

export function isClaudeTodoToolName(name: unknown): boolean {
  return typeof name === "string" && TODO_TOOL_NAMES.has(name);
}

function readStatus(value: unknown): ClaudeTodoStatus | undefined {
  return value === "pending" || value === "in_progress" || value === "completed"
    ? value
    : undefined;
}

function readText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const text = value.replace(/\s+/g, " ").trim();
  return text || undefined;
}

function readId(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return readText(value)?.replace(/^#/, "");
}

/** `TodoWrite` input → list; undefined when the input is not a todo list. */
export function readClaudeTodoWriteItems(input: unknown): ClaudeTodoItem[] | undefined {
  if (!isRecord(input) || !Array.isArray(input.todos)) {
    return undefined;
  }
  const items: ClaudeTodoItem[] = [];
  for (const entry of input.todos) {
    if (!isRecord(entry)) {
      continue;
    }
    const text = readText(entry.content) ?? readText(entry.activeForm);
    const status = readStatus(entry.status);
    if (text && status) {
      items.push({ ...(readId(entry.id) ? { id: readId(entry.id) } : {}), text, status });
    }
  }
  return items;
}

function resultText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((block) => (isRecord(block) && typeof block.text === "string" ? block.text : ""))
    .join("\n");
}

function readCreatedTaskId(content: unknown, structured: unknown): string | undefined {
  const task = isRecord(structured) && isRecord(structured.task) ? structured.task : undefined;
  return readId(task?.id) ?? /Task #([\w-]+) created/i.exec(resultText(content))?.[1];
}

/** `TaskList` result → list; undefined when it cannot be read. */
export function readClaudeTaskListItems(
  content: unknown,
  structured: unknown,
): ClaudeTodoItem[] | undefined {
  if (isRecord(structured) && Array.isArray(structured.tasks)) {
    const items: ClaudeTodoItem[] = [];
    for (const task of structured.tasks) {
      if (!isRecord(task)) {
        continue;
      }
      const id = readId(task.id);
      const text = readText(task.subject) ?? readText(task.description);
      const status = readStatus(task.status);
      if (text && status) {
        items.push({ ...(id ? { id } : {}), text, status });
      }
    }
    return items;
  }
  const text = resultText(content);
  if (/^\s*no tasks/i.test(text)) {
    return [];
  }
  const items: ClaudeTodoItem[] = [];
  for (const line of text.split("\n")) {
    const match = /^\s*#([\w-]+)\s*\[(pending|in_progress|completed)\]\s*(.+)$/.exec(line);
    const lineText = readText(match?.[3]);
    if (match && lineText) {
      items.push({ id: match[1], text: lineText, status: match[2] as ClaudeTodoStatus });
    }
  }
  return items.length > 0 ? items : undefined;
}

/**
 * Projects Claude's list onto progress-card steps: the card keeps at most one
 * `in_progress` step and 50 steps of 512 bytes, so later parallel work reads as pending.
 */
export function projectClaudeTodoSteps(items: readonly ClaudeTodoItem[]): ProgressCardStep[] {
  let inProgressSeen = false;
  return items.slice(0, PROGRESS_CARD_MAX_STEPS).map((item) => {
    let status = item.status;
    if (status === "in_progress") {
      status = inProgressSeen ? "pending" : "in_progress";
      inProgressSeen = true;
    }
    return { step: truncateUtf8Prefix(item.text, PROGRESS_CARD_MAX_STEP_UTF8_BYTES), status };
  });
}

type PendingCall = { name: string; input: unknown };

/**
 * Observes Claude CLI records of one run and reports the session's todo list as
 * progress-card steps whenever it changes. `stateKey` names the CLI conversation.
 */
export function createClaudeCliTodoObserver(params: {
  stateKey: string;
  onChange: (steps: ProgressCardStep[]) => void;
}) {
  const pending = new Map<string, PendingCall>();
  const report = (state: ClaudeTodoState) => {
    state.touched = true;
    try {
      params.onChange(projectClaudeTodoSteps(state.items));
    } catch {
      // Presentation only; it must not end the turn.
    }
  };
  const applyResult = (call: PendingCall, content: unknown, structured: unknown) => {
    const state = readSessionState(params.stateKey);
    const input = isRecord(call.input) ? call.input : {};
    switch (call.name) {
      case "TodoWrite": {
        const items = readClaudeTodoWriteItems(input);
        if (!items) {
          return;
        }
        state.items = items;
        report(state);
        return;
      }
      case "TaskCreate": {
        const text = readText(input.subject) ?? readText(input.description);
        if (!text) {
          return;
        }
        const id = readCreatedTaskId(content, structured);
        // A new task list (a fresh CLI session) numbers from #1 again.
        state.items = id ? state.items.filter((item) => item.id !== id) : state.items;
        state.items.push({ ...(id ? { id } : {}), text, status: "pending" });
        report(state);
        return;
      }
      case "TaskUpdate": {
        const id = readId(input.taskId);
        const index = id ? state.items.findIndex((item) => item.id === id) : -1;
        if (index < 0) {
          return;
        }
        if (input.status === "deleted") {
          state.items.splice(index, 1);
        } else {
          const item = state.items[index];
          if (!item) {
            return;
          }
          const status = readStatus(input.status) ?? item.status;
          const text = readText(input.subject) ?? item.text;
          if (status === item.status && text === item.text) {
            return;
          }
          state.items[index] = { ...item, status, text };
        }
        report(state);
        return;
      }
      case "TaskList": {
        const items = readClaudeTaskListItems(content, structured);
        if (!items) {
          return;
        }
        state.items = items;
        report(state);
      }
    }
  };
  return {
    observe(record: Record<string, unknown>) {
      if (typeof record.parent_tool_use_id === "string" && record.parent_tool_use_id) {
        return;
      }
      const message = isRecord(record.message) ? record.message : undefined;
      if (!message || !Array.isArray(message.content)) {
        return;
      }
      if (record.type === "assistant") {
        for (const block of message.content) {
          if (
            isRecord(block) &&
            block.type === "tool_use" &&
            typeof block.id === "string" &&
            isClaudeTodoToolName(block.name)
          ) {
            if (pending.size >= MAX_PENDING_CALLS) {
              pending.delete(pending.keys().next().value as string);
            }
            pending.set(block.id, { name: block.name as string, input: block.input });
          }
        }
        return;
      }
      if (record.type !== "user") {
        return;
      }
      const results = message.content.filter(
        (block) => isRecord(block) && block.type === "tool_result",
      ) as Array<Record<string, unknown>>;
      for (const block of results) {
        const id = typeof block.tool_use_id === "string" ? block.tool_use_id : undefined;
        const call = id ? pending.get(id) : undefined;
        if (!id || !call) {
          continue;
        }
        pending.delete(id);
        if (block.is_error === true) {
          continue;
        }
        // One result per record carries the structured `tool_use_result`.
        applyResult(call, block.content, results.length === 1 ? record.tool_use_result : undefined);
      }
    },
  };
}
