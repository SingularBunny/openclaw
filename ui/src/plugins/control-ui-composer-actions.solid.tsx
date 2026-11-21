// Fork: compact plugin action buttons in the composer's control row (ControlUiAction placement "composer-controls"),
// next to the permission, Claude mode, model and effort pickers, and in the chat's own header ("chat-header"), next to
// Add to group chat. A button with the action's label (or icon); the label carries the state, e.g. "Plan: on".
import { For, Show, createMemo, createSignal, onCleanup } from "solid-js";
import type { ControlUiAction } from "../../../src/plugin-sdk/control-ui.js";
import { iconData, type IconName } from "../components/icon-data.ts";
import { Icon } from "../components/solid/icon.tsx";
import { useOptionalApplication } from "../lib/reactive/context.ts";
import { findUiSessionRow } from "../lib/sessions/route-navigation.ts";
import { runControlUiPluginAction } from "./control-ui-actions.ts";
import type { ControlUiRegistration } from "./control-ui-capability.ts";
import "./control-ui-composer-actions.css";

const isIconName = (name: string | undefined): name is IconName =>
  Boolean(name && Object.hasOwn(iconData, name));

type InlinePlacement = Extract<ControlUiAction["placement"], "composer-controls" | "chat-header">;

const BUTTON_CLASS: Record<InlinePlacement, string> = {
  "composer-controls": "chat-controls__inline-select-trigger chat-controls__plugin-action",
  "chat-header": "btn btn--sm chat-pane-header__plugin-action",
};

export function PluginComposerControlActions(props: { sessionKey?: string; agentId?: string }) {
  return <PluginInlineActions placement="composer-controls" {...props} />;
}

export function PluginChatHeaderActions(props: { sessionKey?: string; agentId?: string }) {
  return <PluginInlineActions placement="chat-header" {...props} />;
}

function PluginInlineActions(props: {
  placement: InlinePlacement;
  sessionKey?: string;
  agentId?: string;
}) {
  // Optional: headers and composers also render standalone (tests, previews) without an application.
  const context = useOptionalApplication();
  const [version, setVersion] = createSignal(0);
  const [error, setError] = createSignal("");
  const stop = context?.plugins?.subscribe(() => setVersion((v) => v + 1));
  onCleanup(() => stop?.());
  const lifetime = new AbortController();
  onCleanup(() => lifetime.abort());
  const session = () =>
    context && props.sessionKey
      ? findUiSessionRow(context, props.sessionKey, props.agentId)
      : undefined;
  const actions = createMemo(() => {
    void version();
    if (!props.sessionKey) {
      return [];
    }
    return (
      context?.plugins
        ?.registrations("actions")
        .filter((entry) => entry.value.placement === props.placement)
        .flatMap((entry: ControlUiRegistration<ControlUiAction>) => {
          try {
            const row = session();
            const state = entry.value.resolve?.({
              sessionKey: props.sessionKey!,
              agentId: props.agentId ?? row?.agentId,
              session: row ? structuredClone(row) : undefined,
            });
            return state?.hidden ? [] : [{ entry, state }];
          } catch (failure) {
            context?.plugins.reportError(entry.pluginId, failure);
            return [];
          }
        }) ?? []
    );
  });
  return (
    <For each={actions()} keyed={(action) => action.entry.signal}>
      {(action) => {
        const label = () => action().state?.label ?? action().entry.value.label;
        const icon = () => action().state?.icon ?? action().entry.value.icon;
        // The chat header shows icon and label together, like its built-in buttons.
        const withLabel = () => props.placement === "chat-header";
        return (
          <openclaw-tooltip prop:content={error() || label()}>
            <button
              class={BUTTON_CLASS[props.placement]}
              type="button"
              data-plugin-composer-action={action().entry.key}
              aria-label={label()}
              disabled={action().state?.disabled ?? false}
              onClick={() =>
                void (async () => {
                  const runtime = context?.plugins;
                  if (!runtime || !props.sessionKey) {
                    return;
                  }
                  setError("");
                  try {
                    await runControlUiPluginAction({
                      runtime,
                      id: action().entry.key,
                      placement: props.placement,
                      sessionKey: props.sessionKey,
                      agentId: props.agentId,
                      session: session(),
                      signal: AbortSignal.any([lifetime.signal, action().entry.signal]),
                    });
                  } catch (failure) {
                    if (!lifetime.signal.aborted) {
                      setError(failure instanceof Error ? failure.message : String(failure));
                    }
                  }
                })()
              }
            >
              <Show when={isIconName(icon())} fallback={<span>{label()}</span>}>
                <Icon name={icon() as IconName} />
                <Show when={withLabel()}>
                  <span>{label()}</span>
                </Show>
              </Show>
            </button>
          </openclaw-tooltip>
        );
      }}
    </For>
  );
}
