// Fork: group chat buttons. "Add to group chat" (chat header and the Hand off menu) adds an agent, ACP agent or
// model as a separate participant; the strip by the composer lists the members with an "Ask <name>" chip each, a
// remove button, and Stop while a member answers. State and actions come from the chat's group controller.
import { createMemo, createSignal, For, Show } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { registerModelControlsEnglish } from "../../../i18n/locales/en-model-controls.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import {
  readChatGroupController,
  type ChatGroupController,
  type ChatGroupTarget,
} from "../chat-group-registry.ts";
import { focusComposerAfterMention } from "./chat-group-ask-focus.ts";

registerEnglishCatalog(registerModelControlsEnglish);

function hasGroupTargets(controller: ChatGroupController | undefined) {
  const targets = controller?.targets;
  return Boolean(
    targets && targets.agents.length + targets.acpAgents.length + targets.models.length,
  );
}

function GroupTargetList(props: {
  label: string;
  targets: readonly ChatGroupTarget[];
  onPick: (target: ChatGroupTarget) => void;
}) {
  return (
    <Show when={props.targets.length > 0}>
      <div class="chat-handoff-menu__group" role="group" aria-label={props.label}>
        <div class="chat-handoff-menu__heading">{props.label}</div>
        <For each={props.targets} keyed={(target) => `${target.member.kind}:${target.member.id}`}>
          {(target) => (
            <button
              type="button"
              role="menuitem"
              class="chat-handoff-menu__item"
              data-chat-group-add={`${target().member.kind}:${target().member.id}`}
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

/** The candidates to add: OpenClaw agents, ACP agents and models; picking one adds it to the chat. */
export function ChatGroupTargetLists(props: {
  controller: ChatGroupController;
  onPicked?: () => void;
}) {
  const pick = (target: ChatGroupTarget) => {
    props.onPicked?.();
    void props.controller.add(target);
  };
  return (
    <>
      <GroupTargetList
        label={t("chat.group.agents")}
        targets={props.controller.targets.agents}
        onPick={pick}
      />
      <GroupTargetList
        label={t("chat.group.acpAgents")}
        targets={props.controller.targets.acpAgents}
        onPick={pick}
      />
      <GroupTargetList
        label={t("chat.handoff.models")}
        targets={props.controller.targets.models}
        onPick={pick}
      />
    </>
  );
}

/** "Add to group chat" in the chat header. */
export function ChatGroupHeaderButton(props: { sessionKey?: string }) {
  const controller = createMemo(() => readChatGroupController(props.sessionKey));
  const [open, setOpen] = createSignal(false);
  let details: HTMLDetailsElement | undefined;
  return (
    <Show when={hasGroupTargets(controller())}>
      <details
        ref={(element) => {
          details = element;
        }}
        class="chat-handoff-menu chat-group-menu"
        data-chat-group-menu
        onToggle={(event: Event) => setOpen((event.currentTarget as HTMLDetailsElement).open)}
      >
        <summary
          class="btn btn--sm btn--ghost chat-group-menu__button"
          aria-label={t("chat.group.addTitle")}
          title={t("chat.group.addTitle")}
        >
          <Icon name="userPlus" />
          <span>{t("chat.group.add")}</span>
        </summary>
        <Show when={open()}>
          <div class="chat-handoff-menu__popover" role="menu">
            <ChatGroupTargetLists
              controller={controller()!}
              onPicked={() => {
                setOpen(false);
                if (details) {
                  details.open = false;
                }
              }}
            />
          </div>
        </Show>
      </details>
    </Show>
  );
}

/** By the composer: the members, "Ask <name>" for each, and Stop while one answers. */
export function ChatGroupStrip(props: { sessionKey?: string }) {
  const controller = createMemo(() => readChatGroupController(props.sessionKey));
  const members = () => controller()?.info?.members ?? [];
  const runningName = () =>
    members().find((member) => member.key === controller()?.info?.running)?.name;
  return (
    <Show when={members().length > 0}>
      <div
        class="chat-composer-neighbor-card chat-composer-neighbor-card--info chat-group-strip"
        role="group"
        aria-label={t("chat.group.members")}
        data-chat-group-strip
      >
        <span class="chat-composer-neighbor-card__icon" aria-hidden="true">
          <Icon name="users" />
        </span>
        <div class="chat-composer-neighbor-card__copy chat-group-strip__members">
          <strong>{t("chat.group.title")}</strong>
          <For each={members()} keyed={(member) => member.key}>
            {(member) => (
              <span class="chat-group-strip__member" data-chat-group-member={member().key}>
                <button
                  class="btn btn--sm"
                  type="button"
                  title={t("chat.group.askTitle", { name: member().name })}
                  data-chat-group-ask={member().key}
                  disabled={controller()?.busy}
                  onClick={(event) => {
                    controller()?.ask(member());
                    focusComposerAfterMention(event.currentTarget, `@${member().name} `);
                  }}
                >
                  {t("chat.group.ask", { name: member().name })}
                </button>
                <button
                  class="btn btn--sm btn--ghost"
                  type="button"
                  aria-label={t("chat.group.remove", { name: member().name })}
                  title={t("chat.group.remove", { name: member().name })}
                  data-chat-group-remove={member().key}
                  disabled={controller()?.info?.running === member().key}
                  onClick={() => void controller()?.remove(member().key)}
                >
                  <Icon name="x" />
                </button>
              </span>
            )}
          </For>
        </div>
        <Show when={runningName()}>
          {(name) => (
            <>
              <span class="chat-group-strip__running" role="status">
                {t("chat.group.answering", { name: name() })}
              </span>
              <button
                class="btn btn--sm"
                type="button"
                data-chat-group-stop
                onClick={() => void controller()?.stop()}
              >
                <Icon name="square" />
                {t("chat.group.stop")}
              </button>
            </>
          )}
        </Show>
      </div>
    </Show>
  );
}
