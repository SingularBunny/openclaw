// Fork (N11): "Forget a topic…" in the chat's ⋯ menu. The user names a topic, the Gateway ranks
// the chat's turns against it with the local embedding model (`chat.forget.find`, no chat model
// involved), the user ticks what to forget, and `chat.forget.apply` leaves those turns out of
// every model context. They stay visible in the chat; a summary written over them is replaced
// and a Claude CLI chat starts a fresh native session on its next turn.
import { createMemo, createSignal, For, Show, untrack } from "solid-js";
import { showInputDialog } from "../../components/input-dialog.tsx";
import { withPromiseModalHost } from "../../components/promise-modal-host.ts";
import { registerModelControlsEnglish } from "../../i18n/locales/en-model-controls.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";

registerEnglishCatalog(registerModelControlsEnglish);

export const CHAT_FORGET_FIND_METHOD = "chat.forget.find";
export const CHAT_FORGET_APPLY_METHOD = "chat.forget.apply";

export type ChatForgetCandidate = {
  id: string;
  entryIds: string[];
  preview: string;
  timestamp?: string;
  beforeSummary: boolean;
  score: number;
  literal: boolean;
  selected: boolean;
};

export type ChatForgetMemoryCandidate = {
  id: string;
  file: string;
  hash: string;
  preview: string;
  score: number;
  literal: boolean;
  selected: boolean;
};

export type ChatForgetPicks = { entryIds: string[]; memory: { file: string; hash: string }[] };

export type ChatForgetHost = {
  sessionKey: string;
  client?: {
    request<T>(method: string, params: Record<string, unknown>): Promise<T>;
  } | null;
};

type Dialogs = {
  askTopic: (find: (topic: string) => Promise<string | null>) => Promise<string | null>;
  pick: (
    topic: string,
    candidates: ChatForgetCandidate[],
    memory: ChatForgetMemoryCandidate[],
  ) => Promise<ChatForgetPicks | null>;
};

/** What the ticks select: the rows of ticked turns and the ticked memory paragraphs. */
export function forgetPicks(
  candidates: readonly ChatForgetCandidate[],
  memory: readonly ChatForgetMemoryCandidate[],
  ticked: ReadonlySet<string>,
): ChatForgetPicks {
  return {
    entryIds: candidates
      .filter((candidate) => ticked.has(candidate.id))
      .flatMap((candidate) => candidate.entryIds),
    memory: memory
      .filter((paragraph) => ticked.has(paragraph.id))
      .map(({ file, hash }) => ({ file, hash })),
  };
}

/** Runs the whole flow; resolves how many rows and paragraphs were forgotten (0 when cancelled). */
export async function runForgetTopic(
  host: ChatForgetHost,
  dialogs: Dialogs = { askTopic: askForgetTopic, pick: pickForgetTurns },
): Promise<number> {
  const client = host.client;
  if (!client) {
    return 0;
  }
  const sessionKey = host.sessionKey;
  let candidates: ChatForgetCandidate[] = [];
  let memory: ChatForgetMemoryCandidate[] = [];
  const topic = await dialogs.askTopic(async (value) => {
    const result = await client.request<{
      candidates: ChatForgetCandidate[];
      memory?: ChatForgetMemoryCandidate[];
    }>(CHAT_FORGET_FIND_METHOD, { sessionKey, topic: value });
    candidates = result.candidates ?? [];
    memory = result.memory ?? [];
    return candidates.length + memory.length > 0 ? null : t("chat.forget.nothingFound");
  });
  if (!topic || candidates.length + memory.length === 0 || host.sessionKey !== sessionKey) {
    return 0;
  }
  const picks = await dialogs.pick(topic, candidates, memory);
  if (
    !picks ||
    picks.entryIds.length + picks.memory.length === 0 ||
    host.sessionKey !== sessionKey
  ) {
    return 0;
  }
  const result = await client.request<{ forgotten: string[]; memoryRemoved?: number }>(
    CHAT_FORGET_APPLY_METHOD,
    { sessionKey, topic, entryIds: picks.entryIds, memory: picks.memory },
  );
  return (result.forgotten?.length ?? 0) + (result.memoryRemoved ?? 0);
}

function askForgetTopic(find: (topic: string) => Promise<string | null>) {
  return showInputDialog({
    title: t("chat.forget.title"),
    label: t("chat.forget.topicLabel"),
    submitLabel: t("chat.forget.find"),
    requireValue: true,
    submit: find,
  });
}

function pickForgetTurns(
  topic: string,
  candidates: ChatForgetCandidate[],
  memory: ChatForgetMemoryCandidate[],
): Promise<ChatForgetPicks | null> {
  return withPromiseModalHost<ChatForgetPicks | null>({ value: null }, (modal) =>
    modal.render(() => (
      <ForgetPicker topic={topic} candidates={candidates} memory={memory} finish={modal.finish} />
    )),
  );
}

function ForgetRow(props: {
  id: string;
  preview: string;
  detail?: string;
  score: number;
  literal: boolean;
  checked: boolean;
  onToggle: (on: boolean) => void;
}) {
  return (
    <li>
      <label class="chat-forget__item">
        <input
          type="checkbox"
          data-chat-forget-item={props.id}
          checked={props.checked}
          onChange={(event) => props.onToggle(event.currentTarget.checked)}
        />
        <span class="chat-forget__preview">
          {props.preview}
          <Show when={props.detail}>
            <span class="chat-forget__file">{props.detail}</span>
          </Show>
        </span>
        <span class="chat-forget__score">
          {Math.round(props.score * 100)}%{props.literal ? ` · ${t("chat.forget.mentions")}` : ""}
        </span>
      </label>
    </li>
  );
}

function ForgetPicker(props: {
  topic: string;
  candidates: ChatForgetCandidate[];
  memory: ChatForgetMemoryCandidate[];
  finish: (value: ChatForgetPicks | null) => void;
}) {
  // The pre-selection is read once: the lists do not change while the dialog is open.
  const [ticked, setTicked] = createSignal<ReadonlySet<string>>(
    untrack(
      () =>
        new Set(
          [...props.candidates, ...props.memory]
            .filter((item) => item.selected)
            .map((item) => item.id),
        ),
    ),
  );
  const toggle = (id: string, on: boolean) =>
    setTicked((current) => {
      const next = new Set(current);
      if (on) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  const dropsSummary = createMemo(() =>
    props.candidates.some((candidate) => candidate.beforeSummary && ticked().has(candidate.id)),
  );
  const count = () => ticked().size;
  return (
    <openclaw-modal-dialog
      label={t("chat.forget.pickTitle", { topic: props.topic })}
      description={t("chat.forget.pickHint")}
      onModal-cancel={() => props.finish(null)}
    >
      <form
        class="exec-approval-card chat-forget"
        data-chat-forget
        onSubmit={(event) => {
          event.preventDefault();
          const picks = forgetPicks(props.candidates, props.memory, ticked());
          if (picks.entryIds.length + picks.memory.length > 0) {
            props.finish(picks);
          }
        }}
      >
        <div class="exec-approval-header">
          <div class="exec-approval-title">
            {t("chat.forget.pickTitle", { topic: props.topic })}
          </div>
        </div>
        <p class="chat-forget__hint">{t("chat.forget.pickHint")}</p>
        <Show when={props.candidates.length > 0}>
          <div class="chat-forget__heading">{t("chat.forget.inChat")}</div>
          <ul class="chat-forget__list">
            <For each={props.candidates} keyed={(candidate) => candidate.id}>
              {(candidate) => (
                <ForgetRow
                  id={candidate().id}
                  preview={candidate().preview}
                  score={candidate().score}
                  literal={candidate().literal}
                  checked={ticked().has(candidate().id)}
                  onToggle={(on) => toggle(candidate().id, on)}
                />
              )}
            </For>
          </ul>
        </Show>
        <Show when={props.memory.length > 0}>
          <div class="chat-forget__heading">{t("chat.forget.inMemory")}</div>
          <ul class="chat-forget__list">
            <For each={props.memory} keyed={(paragraph) => paragraph.id}>
              {(paragraph) => (
                <ForgetRow
                  id={paragraph().id}
                  preview={paragraph().preview}
                  detail={paragraph().file.split("/").slice(-2).join("/")}
                  score={paragraph().score}
                  literal={paragraph().literal}
                  checked={ticked().has(paragraph().id)}
                  onToggle={(on) => toggle(paragraph().id, on)}
                />
              )}
            </For>
          </ul>
        </Show>
        <Show when={dropsSummary()}>
          <p class="chat-forget__note" data-chat-forget-summary>
            {t("chat.forget.summaryNote")}
          </p>
        </Show>
        <openclaw-modal-actions class="exec-approval-actions">
          <button type="button" class="btn" onClick={() => props.finish(null)}>
            {t("common.cancel")}
          </button>
          <button type="submit" class="btn danger" data-chat-forget-apply disabled={count() === 0}>
            {t("chat.forget.apply", { count: String(count()) })}
          </button>
        </openclaw-modal-actions>
      </form>
    </openclaw-modal-dialog>
  );
}
