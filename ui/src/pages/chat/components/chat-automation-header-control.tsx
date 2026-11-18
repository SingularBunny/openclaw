import { html, nothing } from "lit";
import { Show } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { automationSessionJobId } from "../../../lib/cron/automation-session.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../../lit/solid-bridge.ts";
import { AutomationChatJobsData } from "../automation-chat-jobs-data.ts";
import { AutomationRunControl } from "./chat-automation-run-control.tsx";
import { useSessionPanel, type SessionPanelProps } from "./chat-session-panel.tsx";

type Props = SessionPanelProps & { onOpenRuns?: () => void };
export type ChatAutomationHeaderControl = SolidBridgeElement<Props, { refresh(): Promise<void> }>;

/** The automation chat's own controls in its header: open the Runs tab, and Run now. */
export const ChatAutomationHeaderControl = defineSolidBridge<Props, { refresh(): Promise<void> }>(
  "openclaw-chat-automation-header-control",
  (props, host) => {
    const data = useSessionPanel(props, AutomationChatJobsData, () => undefined);
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

/** Header content for an isolated automation chat whose history may be read; nothing otherwise. */
export function renderChatAutomationHeaderControl(params: {
  sessionKey: string | undefined;
  agentId: string;
  presented: boolean;
  runsAvailable: boolean;
  onOpenRuns: () => void;
}) {
  return params.runsAvailable && params.sessionKey && automationSessionJobId(params.sessionKey)
    ? html`<openclaw-chat-automation-header-control
        .sessionKey=${params.sessionKey}
        .agentId=${params.agentId}
        .presented=${params.presented}
        .onOpenRuns=${params.onOpenRuns}
      ></openclaw-chat-automation-header-control>`
    : nothing;
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-chat-automation-header-control": ChatAutomationHeaderControl;
  }
}
