import { Show } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { automationSessionJobId } from "../../../lib/cron/automation-session.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../../lib/solid-bridge.ts";
import { AutomationChatJobsData } from "../automation-chat-jobs-data.ts";
import { AutomationRunControl } from "./chat-automation-run-control.tsx";
import { useSessionPanel, type SessionPanelProps } from "./chat-session-panel.tsx";

type Props = SessionPanelProps & { onOpenRuns?: () => void };
export type ChatAutomationHeaderControl = SolidBridgeElement<Props, { refresh(): Promise<void> }>;

/** The automation chat's own controls in its header: open the Runs tab, and Run now. */
export const ChatAutomationHeaderControl = defineSolidBridge<Props, { refresh(): Promise<void> }>(
  "openclaw-chat-automation-header-control",
  (props, host) => {
    const data = useSessionPanel(
      host,
      () => ({ sessionKey: host.sessionKey, agentId: host.agentId, presented: host.presented }),
      AutomationChatJobsData,
      () => undefined,
    );
    host.refresh = () => data().refresh();
    return (
      <span class="chat-automation-header">
        <Show when={props.onOpenRuns}>
          {(open) => (
            <button
              class="btn btn--sm btn--ghost chat-automation-header__runs"
              type="button"
              data-test-id="automation-header-runs"
              title={t("chat.automationRuns.openRunsTitle")}
              onClick={() => open()()}
            >
              <Icon name="history" />
              {t("chat.automationRuns.runs")}
            </button>
          )}
        </Show>
        <AutomationRunControl data={data} />
      </span>
    );
  },
  {
    properties: {
      sessionKey: { default: "", attribute: false },
      agentId: { default: "main", attribute: false },
      presented: { default: true, type: Boolean },
      onOpenRuns: { default: undefined, attribute: false },
    },
    methods: { refresh: () => Promise.resolve() },
  },
);

/** Whether an isolated automation chat shows its header controls (Runs, Run now). */
export function showsChatAutomationHeaderControl(
  sessionKey: string | undefined,
  runsAvailable: boolean,
): sessionKey is string {
  return runsAvailable && Boolean(sessionKey && automationSessionJobId(sessionKey));
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-chat-automation-header-control": ChatAutomationHeaderControl;
  }
}
