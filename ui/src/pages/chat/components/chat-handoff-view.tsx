// Fork: buttons that switch who answers a chat — "Hand off to…" under a reply, Retry and
// "Choose another model" under a failed turn, and the "<new> is answering · Return to <previous>"
// chip by the composer. State and actions come from the chat's published handoff controller.
import type { JSX } from "@solidjs/web";
import { createMemo, createSignal, For, Show } from "solid-js";
import type { RefusalSignal } from "../../../../../src/shared/refusal-signal.js";
import { Icon } from "../../../components/solid/icon.tsx";
import { registerModelControlsEnglish } from "../../../i18n/locales/en-model-controls.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import {
  isRefusalHandedOff,
  readChatHandoffController,
  sameChatAnswerer,
  type ChatHandoffController,
  type ChatHandoffTarget,
} from "../chat-handoff-registry.ts";

registerEnglishCatalog(registerModelControlsEnglish);

/** The chip's state: who answers now and who answered before, or undefined when not handed off. */
export function resolveChatHandoffChip(controller: ChatHandoffController | undefined) {
  if (!controller?.current || !controller.previous) {
    return undefined;
  }
  return {
    current: controller.labelOf(controller.current),
    previous: controller.labelOf(controller.previous),
    recorded: Boolean(controller.info?.handoff),
  };
}

export function ChatHandoffChip(props: { sessionKey?: string }) {
  const controller = createMemo(() => readChatHandoffController(props.sessionKey));
  const chip = createMemo(() => resolveChatHandoffChip(controller()));
  return (
    <Show when={chip()}>
      {(state) => (
        <div
          class="chat-composer-neighbor-card chat-composer-neighbor-card--info chat-handoff-chip"
          role="status"
          data-chat-handoff-chip
        >
          <span class="chat-composer-neighbor-card__icon" aria-hidden="true">
            <Icon name="arrowLeftRight" />
          </span>
          <div class="chat-composer-neighbor-card__copy">
            <strong>{t("chat.handoff.answering", { current: state().current })}</strong>
          </div>
          <button
            class="btn btn--sm"
            type="button"
            data-chat-handoff-return
            disabled={controller()?.busy}
            onClick={() => void controller()?.returnToPrevious()}
          >
            {t("chat.handoff.returnTo", { previous: state().previous })}
          </button>
          <Show when={state().recorded}>
            <button
              class="btn btn--sm btn--ghost"
              type="button"
              aria-label={t("chat.handoff.dismiss")}
              data-chat-handoff-dismiss
              onClick={() => controller()?.dismiss()}
            >
              <Icon name="x" />
            </button>
          </Show>
        </div>
      )}
    </Show>
  );
}

function HandoffTargetList(props: {
  label: string;
  targets: readonly ChatHandoffTarget[];
  controller: ChatHandoffController;
  onPick: (target: ChatHandoffTarget) => void;
}) {
  return (
    <Show when={props.targets.length > 0}>
      <div class="chat-handoff-menu__group" role="group" aria-label={props.label}>
        <div class="chat-handoff-menu__heading">{props.label}</div>
        <For each={props.targets} keyed={(target) => JSON.stringify(target.answerer)}>
          {(target) => (
            <button
              type="button"
              role="menuitem"
              class="chat-handoff-menu__item"
              data-chat-handoff-target={JSON.stringify(target().answerer)}
              disabled={sameChatAnswerer(target().answerer, props.controller.current)}
              onClick={() => props.onPick(target())}
            >
              {target().label}
            </button>
          )}
        </For>
      </div>
    </Show>
  );
}

/**
 * The hand-off menu (ACP agents and catalog models). Picking one hands the reply's question to
 * it; from the refusal hint (fork, I14) the refused turn is first left out of the model context.
 */
function HandoffMenu(props: {
  controller: ChatHandoffController;
  messageKey?: string;
  refusal?: RefusalSignal;
  class?: string;
  summaryClass: string;
  summaryLabel: string;
  summaryTitle: string;
  summary: JSX.Element;
}) {
  const [open, setOpen] = createSignal(false);
  let details: HTMLDetailsElement | undefined;
  const pick = (target: ChatHandoffTarget) => {
    setOpen(false);
    if (details) {
      details.open = false;
    }
    void props.controller.handOff(target.answerer, {
      resendBefore: props.messageKey,
      ...(props.refusal ? { refusal: props.refusal } : {}),
    });
  };
  return (
    <details
      ref={(element) => {
        details = element;
      }}
      class={["chat-handoff-menu", props.class]}
      data-chat-handoff-menu
      onToggle={(event: Event) => setOpen((event.currentTarget as HTMLDetailsElement).open)}
    >
      <summary
        class={props.summaryClass}
        aria-label={props.summaryLabel}
        title={props.summaryTitle}
        aria-disabled={props.controller.busy ? "true" : "false"}
        onClick={(event: MouseEvent) => {
          if (props.controller.busy) {
            event.preventDefault();
          }
        }}
      >
        {props.summary}
      </summary>
      <Show when={open()}>
        <div class="chat-handoff-menu__popover" role="menu">
          <Show when={props.controller.longContext}>
            <p class="chat-handoff-menu__warning" data-chat-handoff-long-context>
              {t("chat.handoff.longContext")}
            </p>
          </Show>
          <HandoffTargetList
            label={t("chat.handoff.agents")}
            targets={props.controller.agents}
            controller={props.controller}
            onPick={pick}
          />
          <HandoffTargetList
            label={t("chat.handoff.models")}
            targets={props.controller.models}
            controller={props.controller}
            onPick={pick}
          />
        </div>
      </Show>
    </details>
  );
}

function hasHandoffTargets(controller: ChatHandoffController | undefined) {
  return Boolean(controller && controller.models.length + controller.agents.length > 0);
}

/** "Hand off to…" under an assistant reply: any model or ACP agent answers its question again. */
export function ChatHandoffMessageAction(props: { sessionKey?: string; messageKey?: string }) {
  const controller = createMemo(() => readChatHandoffController(props.sessionKey));
  return (
    <Show when={hasHandoffTargets(controller())}>
      <HandoffMenu
        controller={controller()!}
        messageKey={props.messageKey}
        summaryClass="chat-plugin-message-action chat-handoff-btn"
        summaryLabel={t("chat.handoff.handOffTitle")}
        summaryTitle={t("chat.handoff.handOff")}
        summary={<Icon name="arrowLeftRight" />}
      />
    </Show>
  );
}

/**
 * Fork (I14): under a reply that looks like a refusal, a hint with a **Hand off…** button that
 * opens the same menu. Nothing switches by itself: the user decides (Anthropic's usage policy
 * forbids intentionally bypassing safeguards). A phrase match is worded softer.
 */
export function ChatRefusalHint(props: {
  sessionKey?: string;
  messageKey?: string;
  refusal: RefusalSignal;
}) {
  const controller = createMemo(() => readChatHandoffController(props.sessionKey));
  return (
    <Show when={hasHandoffTargets(controller()) && !isRefusalHandedOff(props.messageKey)}>
      <div
        class={["chat-refusal-hint", { "chat-refusal-hint--weak": props.refusal === "phrase" }]}
        role="note"
        data-chat-refusal-hint={props.refusal}
      >
        <Icon name="arrowLeftRight" />
        <span class="chat-refusal-hint__text">
          {props.refusal === "phrase" ? t("chat.handoff.refusalMaybe") : t("chat.handoff.refusal")}
        </span>
        <HandoffMenu
          controller={controller()!}
          messageKey={props.messageKey}
          refusal={props.refusal}
          class="chat-refusal-hint__menu"
          summaryClass="btn btn--sm chat-refusal-hint__button"
          summaryLabel={t("chat.handoff.refusalButtonTitle")}
          summaryTitle={t("chat.handoff.refusalButtonTitle")}
          summary={t("chat.handoff.refusalButton")}
        />
      </div>
    </Show>
  );
}

/** Under a failed turn: Retry the same message with the same answerer, or pick another model. */
export function ChatTurnFailureActions(props: { sessionKey?: string; messageKey?: string }) {
  const controller = createMemo(() => readChatHandoffController(props.sessionKey));
  return (
    <Show when={controller()}>
      <span class="chat-turn-failure-actions" data-chat-turn-failure-actions>
        <button
          class="btn btn--sm"
          type="button"
          title={t("chat.handoff.retryTitle")}
          disabled={controller()?.busy}
          data-chat-turn-retry
          onClick={() => controller()?.retry(props.messageKey)}
        >
          <Icon name="repeat" />
          {t("chat.handoff.retry")}
        </button>
        <button
          class="btn btn--sm btn--ghost"
          type="button"
          disabled={controller()?.busy}
          data-chat-turn-choose-model
          onClick={() => controller()?.chooseAnotherModel(props.messageKey)}
        >
          {t("chat.handoff.chooseAnotherModel")}
        </button>
      </span>
    </Show>
  );
}
