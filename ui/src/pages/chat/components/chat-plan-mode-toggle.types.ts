// Fork: props of the composer's Plan toggle (aiwb-plan plugin), kept apart from Solid code.
export type ChatPlanModeToggleProps = {
  /** Plan mode is on for this chat. */
  on: boolean;
  /** The Gateway answered at least once; until then the toggle shows "off" quietly. */
  known: boolean;
  pending?: boolean;
  disabled?: boolean;
  disabledReason?: string;
  onToggle: (on: boolean) => unknown;
};
