// A session created as a fork of its parent inherits the parent's widget state.
import { expect, test } from "vitest";
import { createCanvasDocument } from "../canvas/documents.js";
import { getWidgetStorageValue, setWidgetStorageValue } from "../canvas/widget-storage.js";
import {
  requireNonEmptyString,
  setupSessionCreateTestHarness,
} from "./server.sessions.create.test-support.js";
import { testState, writeSessionStore } from "./test-helpers.js";
import {
  directSessionReq,
  seedSessionTranscript,
  sessionStoreEntry,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir } = setupSessionCreateTestHarness();

test("sessions.create copies parent widget state for widgets in the forked history", async () => {
  const { storePath } = await createSessionStoreDir();
  testState.sessionConfig = undefined;
  await writeSessionStore({
    entries: { "agent:main:main": sessionStoreEntry("sess-widget-parent") },
  });
  const widget = await createCanvasDocument({ html: "<p>Counter</p>", cspSandbox: "scripts" });
  await seedSessionTranscript({
    sessionId: "sess-widget-parent",
    sessionKey: "agent:main:main",
    storePath,
    messages: [
      { role: "user", content: "Show a counter." },
      {
        role: "assistant",
        content: [
          { type: "text", text: JSON.stringify({ kind: "canvas", view: { id: widget.id } }) },
        ],
      },
    ],
  });
  await setWidgetStorageValue({ docId: widget.id, scopeKey: "agent:main:main" }, "count", "3");

  const created = await directSessionReq<{ key?: string }>("sessions.create", {
    agentId: "main",
    parentSessionKey: "main",
    key: "agent:main:dashboard:widget-fork",
    fork: true,
  });

  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  const key = requireNonEmptyString(created.payload?.key, "forked session key");
  expect(await getWidgetStorageValue({ docId: widget.id, scopeKey: key }, "count")).toBe("3");
});
