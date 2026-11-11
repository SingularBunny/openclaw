// Fork: plugin actions under a chat message (ControlUiAction placement "message"), next to Reply and Copy
// Markdown. Each action runs with the chat's session and the message (role, Markdown text, transcript id).
import { For, Show, createMemo, createSignal, onCleanup } from "solid-js";
import type { ControlUiAction, ControlUiMessage } from "../../../src/plugin-sdk/control-ui.js";
import { iconData, type IconName } from "../components/icon-data.ts";
import { Icon } from "../components/solid/icon.tsx";
import { useApplication } from "../lib/reactive/context.ts";
import { findUiSessionRow } from "../lib/sessions/route-navigation.ts";
import { runControlUiPluginAction } from "./control-ui-actions.ts";
import type { ControlUiRegistration } from "./control-ui-capability.ts";

const isIconName = (name: string | undefined): name is IconName =>
  Boolean(name && Object.hasOwn(iconData, name));

export function PluginMessageActions(props: {
  sessionKey?: string;
  agentId?: string;
  message: ControlUiMessage;
}) {
  const context = useApplication();
  const [version, setVersion] = createSignal(0);
  const [error, setError] = createSignal("");
  const stop = context?.plugins?.subscribe(() => setVersion((v) => v + 1));
  onCleanup(() => stop?.());
  const lifetime = new AbortController();
  onCleanup(() => lifetime.abort());
  const session = () =>
    context && props.sessionKey ? findUiSessionRow(context, props.sessionKey, props.agentId) : undefined;
  const actions = createMemo(() => {
    void version();
    if (!props.sessionKey || !props.message.text) {
      return [];
    }
    return (
      context?.plugins
        ?.registrations("actions")
        .filter((entry) => entry.value.placement === "message")
        .flatMap((entry: ControlUiRegistration<ControlUiAction>) => {
          try {
            const row = session();
            const state = entry.value.resolve?.({
              sessionKey: props.sessionKey!,
              agentId: props.agentId ?? row?.agentId,
              session: row ? structuredClone(row) : undefined,
              message: structuredClone(props.message),
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
    <>
      <For each={actions()} keyed={(action) => action.entry.signal}>
        {(action) => {
          const label = () => action().state?.label ?? action().entry.value.label;
          const icon = () => action().entry.value.icon;
          return (
            <openclaw-tooltip prop:content={error() || label()}>
              <button
                class="chat-plugin-message-action"
                type="button"
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
                        placement: "message",
                        sessionKey: props.sessionKey,
                        agentId: props.agentId,
                        session: session(),
                        message: props.message,
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
                </Show>
              </button>
            </openclaw-tooltip>
          );
        }}
      </For>
    </>
  );
}
