// Fork (F34): switch the Files panel between the session workspace and the session's folders
// outside it (agent run cwd, session cwd), as sessions.files.list `roots` offers them.
import { For, Show } from "solid-js";
import { t } from "../../../lib/reactive/i18n.ts";
import type { SessionWorkspaceProps } from "./chat-sidebar-view-types.ts";

export function SessionWorkspaceRootSelect(props: {
  workspace: SessionWorkspaceProps;
  class?: string;
}) {
  const roots = () => props.workspace.roots ?? [];
  const current = () => props.workspace.browseRoot ?? roots()[0] ?? "";
  return (
    <Show when={roots().length > 1}>
      <select
        class={["chat-workspace-rail__root-select", props.class]}
        aria-label={t("chat.workspaceFiles.browseRoot")}
        title={current()}
        onChange={(event) => props.workspace.onSelectRoot?.(event.currentTarget.value)}
      >
        <For each={roots()}>
          {(root) => (
            <option value={root} selected={root === current()}>
              {root}
            </option>
          )}
        </For>
      </select>
    </Show>
  );
}
