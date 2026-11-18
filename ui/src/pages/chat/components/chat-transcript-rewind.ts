import type { ChatRewindChoice, ChatRewindFilesProvider } from "../chat-rewind-files.ts";
import type { ChatThreadProps } from "./chat-thread-interactions.ts";

/**
 * Rewind options of a user message group: the rewind itself (focusing the composer once the
 * chat rewound) and, fork (F52), the confirmation's file restore check.
 */
export function chatRewindOptions(
  props: Pick<ChatThreadProps, "onRewindMessage" | "onPreviewRewindFiles" | "onFocusComposer">,
  rewindEntryId: string | null,
): { rewindFiles?: ChatRewindFilesProvider; onRewind?: (choice?: ChatRewindChoice) => void } {
  return {
    rewindFiles:
      rewindEntryId && props.onRewindMessage && props.onPreviewRewindFiles
        ? () => props.onPreviewRewindFiles!(rewindEntryId)
        : undefined,
    onRewind:
      rewindEntryId && props.onRewindMessage
        ? (choice) => {
            void Promise.resolve(props.onRewindMessage?.(rewindEntryId, choice)).then((rewound) => {
              if (rewound) {
                props.onFocusComposer?.();
              }
            });
          }
        : undefined,
  };
}
