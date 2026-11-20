/* @vitest-environment jsdom */
import { expect, it } from "vitest";
import {
  createReviewFixture,
  sidebarPanelFixtureParams,
} from "../../test-helpers/chat-pane-embedded-panels.ts";
import { sidebarPanelDefinitions } from "./chat-pane-embedded-panels.ts";
import { normalizeSidebarLayout } from "./sidebar-layout-normalize.ts";

const panel = (key: string, value: Record<string, unknown>) =>
  ({ key, pluginId: key.split("/")[0], signal: new AbortController().signal, value }) as never;

it("offers a plugin panel only in the chats its available() names, with its own icon", () => {
  const { state } = createReviewFixture();
  const panels = [
    panel("aiwb-automation-chat/runs", {
      id: "runs",
      label: "Runs",
      icon: "calendarClock",
      available: ({ sessionKey }: { sessionKey: string }) => sessionKey.includes(":cron:"),
      mount: () => {},
    }),
    panel("other/notes", { id: "notes", label: "Notes", icon: "no-such-icon", mount: () => {} }),
  ];
  const definitions = (sessionKey: string) => {
    state.sessionKey = sessionKey;
    return sidebarPanelDefinitions(sidebarPanelFixtureParams(state, { pluginPanels: panels }));
  };
  const runs = (key: string) =>
    definitions(key).find((definition) => definition.slot === "plugin:aiwb-automation-chat/runs");
  expect(runs("agent:ops:cron:job-1")).toMatchObject({ available: true, icon: "calendarClock" });
  expect(runs("agent:ops:main")?.available).toBe(false);
  const notes = definitions("agent:ops:main").find(
    (definition) => definition.slot === "plugin:other/notes",
  );
  expect(notes).toMatchObject({ available: true, icon: "plug" });
});

it("opens a tab saved as the former built-in Runs as the plugin's tab", () => {
  const layout = normalizeSidebarLayout({
    columns: [
      { id: "side", side: "right", panels: [{ id: "runs", slot: "runs" }], activePanelId: "runs" },
    ],
  });
  expect(layout.columns[0]?.panels[0]?.slot).toBe("plugin:aiwb-automation-chat/runs");
});
