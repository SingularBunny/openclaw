import { Show } from "solid-js";
import { WidgetStorageFailureNotice } from "../lib/chat/widget-storage-bridge.ts";
import { t } from "../lib/reactive/i18n.ts";

/** A storage failure notice worded for the Control UI widget hosts. */
export function createWidgetStorageNotice(onChange: () => void): WidgetStorageFailureNotice {
  return new WidgetStorageFailureNotice(
    (kind, reason) =>
      t(kind === "save" ? "board.widget.storageSaveFailed" : "board.widget.storageLoadFailed", {
        reason,
      }),
    onChange,
  );
}

/** One dismissible line attached to the widget frame that lost its state. */
export function WidgetStorageNoticeLine(props: { message: string; onDismiss: () => void }) {
  return (
    <Show when={props.message}>
      <div class="board-widget__notice board-widget__notice--dismissible" role="status">
        <span>{props.message}</span>
        <button type="button" class="btn btn--small" onClick={() => props.onDismiss()}>
          {t("common.dismiss")}
        </button>
      </div>
    </Show>
  );
}
