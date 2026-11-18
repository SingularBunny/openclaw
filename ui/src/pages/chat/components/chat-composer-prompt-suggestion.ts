import { insertChatPromptSuggestion } from "../chat-prompt-suggestion.ts";
import type { ComposerPrediction } from "./chat-composer-prediction.ts";
import type { ChatComposerProps } from "./chat-composer-types.ts";

type PromptSuggestionProps = Pick<
  ChatComposerProps,
  | "promptSuggestion"
  | "onDismissPromptSuggestion"
  | "queue"
  | "replyTarget"
  | "suggestionComposer"
  | "getAttachments"
  | "attachments"
>;

/**
 * Claude Code's predicted next prompt (fork): shown through the composer prediction surface
 * while the idle composer is empty and no Labs prediction is showing. `idle` and `quiet` are
 * the composer's own gates, read in this order.
 */
export function createComposerPromptSuggestion(
  props: PromptSuggestionProps,
  prediction: ComposerPrediction | undefined,
  gates: { idle: () => boolean; quiet: () => boolean },
) {
  const text =
    !prediction?.text &&
    props.promptSuggestion &&
    gates.idle() &&
    props.queue.length === 0 &&
    !props.replyTarget &&
    !props.suggestionComposer &&
    gates.quiet() &&
    (props.getAttachments?.() ?? props.attachments ?? []).length === 0
      ? props.promptSuggestion
      : null;
  const dismiss = () => {
    if (props.promptSuggestion) {
      props.onDismissPromptSuggestion?.();
    }
  };
  return {
    text,
    dismiss,
    /** Retires both the Labs prediction and the suggestion. */
    dismissAll: () => {
      prediction?.dismiss();
      dismiss();
    },
    /** Tab: the Labs prediction first, else the suggestion into an empty composer. */
    accept: (target: HTMLTextAreaElement | null) => {
      if (prediction?.text) {
        prediction.acceptInto(target);
        return;
      }
      if (text && target && !target.value) {
        insertChatPromptSuggestion(target, text);
        dismiss();
      }
    },
  };
}
