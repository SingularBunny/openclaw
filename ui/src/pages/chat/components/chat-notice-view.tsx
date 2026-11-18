import { createMemo, Show } from "solid-js";
import { ChatNoticeDetails, type ChatNoticeProps } from "./chat-divider.tsx";
import { ChatTurnFailureActions } from "./chat-handoff-view.tsx";
import { ChatRunFailureNotice } from "./chat-run-failure-notice.tsx";

function FailureNotice(props: ChatNoticeProps) {
  const failure = () => props.item.runError!;
  const actions = createMemo(() => {
    const runId = failure().runId;
    const recovery = props.recovery;
    if (
      !recovery ||
      runId !== recovery.failureActionsRunId ||
      recovery.runActive ||
      recovery.runWorking
    ) {
      return undefined;
    }
    return {
      onRetry: recovery.onRetryRun ? () => recovery.onRetryRun?.(runId) : undefined,
    };
  });
  return (
    <div
      data-chat-row-key={props.item.key}
      data-ts={String(props.item.timestamp)}
      data-run-failure={failure().runId}
    >
      <ChatRunFailureNotice
        summary={failure().summary}
        repeatCount={props.item.repeatCount}
        onRetry={actions()?.onRetry}
        actions={
          actions() && props.recovery?.sessionKey ? (
            <ChatTurnFailureActions sessionKey={props.recovery.sessionKey} />
          ) : undefined
        }
        onOpenModelSetup={
          props.recovery?.applicationContext
            ? () => props.recovery?.applicationContext?.navigate("model-setup")
            : undefined
        }
      />
    </div>
  );
}

export function ChatNotice(props: ChatNoticeProps) {
  return (
    <Show when={props.item.runError} fallback={<ChatNoticeDetails {...props} />}>
      <FailureNotice item={props.item} recovery={props.recovery} />
    </Show>
  );
}
