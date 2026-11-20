// Fork: the Automations run viewer for plugin views (host.components.mountCronRun). A plugin that lists runs
// (`cron.runs`) shows one run's transcript (`cron.history`) in place, as the Automations page and the chat's Runs tab
// do, with "Show earlier" and Close.
import { createEffect, createSignal, onCleanup, untrack } from "solid-js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { CronRunLogEntry } from "../api/types.ts";
import { registerCronEnglish } from "../i18n/locales/en-cron.ts";
import { registerEnglishCatalog } from "../lib/reactive/i18n.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../lib/solid-bridge.ts";
import { CronRunTranscriptView, createCronRunTranscript } from "../pages/cron/run-transcript.tsx";

// The viewer's strings live in the Automations catalog, which a plugin view does not load by itself.
registerEnglishCatalog(registerCronEnglish);

/** The run to show: its job and its run id, or the run time when the log has no id. */
export type PluginCronRun = { jobId: string; runId?: string; runAtMs?: number };

export type PluginCronRunProps = {
  run: PluginCronRun | null;
  client: GatewayBrowserClient | null;
  connected: boolean;
  onClose: (() => void) | null;
};

function PluginCronRunContent(props: PluginCronRunProps) {
  const [revision, setRevision] = createSignal(0, { ownedWrite: true });
  let generation = 0;
  const transcript = createCronRunTranscript(
    () => setRevision((value) => value + 1),
    () =>
      untrack(() => {
        const client = props.client;
        const current = generation;
        return client && props.connected
          ? { client, isCurrent: () => current === generation && untrack(() => props.connected) }
          : null;
      }),
  );
  // Close in the viewer also tells the plugin, so it can return to its list.
  const close = transcript.close;
  transcript.close = (restoreFocus?: boolean) => {
    close(restoreFocus);
    untrack(() => props.onClose)?.();
  };
  // The viewer returns focus to the button that opened the run; a plugin view has none of the host's.
  const anchor = document.createElement("button");
  createEffect(
    () => [props.run?.jobId, props.run?.runId, props.run?.runAtMs, props.client, props.connected],
    () => {
      generation += 1;
      const run = props.run;
      if (!run || !props.client || !props.connected) {
        close();
        return;
      }
      void transcript.open({ ...run, ts: run.runAtMs ?? Date.now() } as CronRunLogEntry, anchor);
    },
  );
  onCleanup(() => {
    generation += 1;
    close();
  });
  return <CronRunTranscriptView transcript={transcript} revision={revision} />;
}

export const PluginCronRun = defineSolidBridge<PluginCronRunProps>(
  "openclaw-plugin-cron-run",
  PluginCronRunContent,
  {
    properties: {
      run: { default: null, attribute: false },
      client: { default: null, attribute: false },
      connected: { default: false, attribute: false },
      onClose: { default: null, attribute: false },
    },
  },
);

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-plugin-cron-run": SolidBridgeElement<PluginCronRunProps>;
  }
}
