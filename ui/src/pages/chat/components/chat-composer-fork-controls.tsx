import { Show } from "solid-js";
import { ChatClaudeModePicker } from "./chat-claude-mode-picker.tsx";
import { ComposerStatusLine } from "./chat-composer-status-line.tsx";
import type { ChatComposerProps } from "./chat-composer-types.ts";
import { ChatPermissionPicker } from "./chat-permission-picker.tsx";
import { ChatPlanModeToggle } from "./chat-plan-mode-toggle.tsx";

type ComposerForkProps = { composer: ChatComposerProps };

/** The composer's lead controls: the permission picker, then the fork's Claude mode and plan mode. */
export function ComposerLeadControls(props: ComposerForkProps) {
  return (
    <>
      <Show when={props.composer.permissionPicker}>
        {(picker) => <ChatPermissionPicker {...picker()} />}
      </Show>
      <Show when={props.composer.claudeModePicker}>
        {(picker) => <ChatClaudeModePicker {...picker()} />}
      </Show>
      <Show when={props.composer.planModeToggle}>
        {(toggle) => <ChatPlanModeToggle {...toggle()} />}
      </Show>
    </>
  );
}

/** Fork (F48): one compact session status line under the composer, like Claude Code's. */
export function ComposerForkStatusLine(props: ComposerForkProps) {
  return (
    <ComposerStatusLine
      session={props.composer.selectedSession}
      runActive={props.composer.runActive}
      providerUsage={props.composer.providerUsage}
      permissionMode={
        props.composer.permissionPicker?.mode ??
        props.composer.permissionPicker?.defaultMode ??
        props.composer.selectedSession?.permissionMode
      }
      claudeMode={props.composer.claudeModePicker?.mode}
    />
  );
}
