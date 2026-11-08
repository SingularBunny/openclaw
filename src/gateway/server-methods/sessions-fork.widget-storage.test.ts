// A forked session starts with a copy of the parent's inline widget state.
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
import type { SessionsForkResult } from "../../../packages/gateway-protocol/src/index.js";
import { createCanvasDocument } from "../../canvas/documents.js";
import { getWidgetStorageValue, setWidgetStorageValue } from "../../canvas/widget-storage.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { createSessionEntryWithTranscript } from "../../config/sessions/session-accessor.entry-mutation.js";
import {
  resolveSqliteScope,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import { appendTranscriptMessage } from "../../config/sessions/session-accessor.transcript.js";
import { waitForSessionTranscriptIndexReconcile } from "../../config/sessions/session-transcript-reconcile.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  cfg,
  invokeMessageCut,
  useMessageCutStorageFixture,
} from "./sessions-rewind.storage.test-support.js";

useMessageCutStorageFixture();

it("sessions.fork copies widget state for widgets in the copied history", async () => {
  await withOpenClawTestState({ label: "fork-widget-storage" }, async (testState) => {
    await testState.writeConfig(cfg);
    setRuntimeConfigSnapshot(cfg);
    const stateDir = testState.stateDir;
    const widget = async () =>
      (await createCanvasDocument({ html: "<p>Counter</p>", cspSandbox: "scripts" }, { stateDir }))
        .id;
    const shown = await widget();
    const later = await widget();
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:dashboard:widget-source",
      sessionId: "widget-fork-source",
    };
    const created = await createSessionEntryWithTranscript(scope, () => ({
      ok: true,
      entry: {
        sessionId: scope.sessionId,
        lifecycleRevision: "widget-fork-source-lifecycle",
        updatedAt: Date.now(),
        visibility: "read-only",
        createdActor: { type: "human", source: "profile", id: "owner" },
      },
    }));
    expect(created.ok).toBe(true);
    for (const message of [
      { eventId: "user-1", parentId: null, role: "user", content: "Show a counter." },
      {
        eventId: "assistant-1",
        parentId: "user-1",
        role: "assistant",
        content: JSON.stringify({ kind: "canvas", view: { id: shown } }),
      },
      { eventId: "user-2", parentId: "assistant-1", role: "user", content: "Show another." },
      {
        eventId: "assistant-2",
        parentId: "user-2",
        role: "assistant",
        content: JSON.stringify({ kind: "canvas", view: { id: later } }),
      },
    ]) {
      await appendTranscriptMessage(scope, {
        eventId: message.eventId,
        parentId: message.parentId,
        message: { role: message.role, content: message.content },
      });
    }
    await waitForSessionTranscriptIndexReconcile(toDatabaseOptions(resolveSqliteScope(scope)));
    const parentStorage = (docId: string) => ({ docId, scopeKey: scope.sessionKey, stateDir });
    await setWidgetStorageValue(parentStorage(shown), "count", "3");
    await setWidgetStorageValue(parentStorage(later), "count", "9");

    // Fork before user-2: the child history holds only the first widget.
    const mutation = invokeMessageCut("sessions.fork", scope);
    expect(await mutation.error).toBeUndefined();
    expect(mutation.respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ sessionKey: expect.any(String) }),
      undefined,
    );
    const result = expectDefined(
      mutation.respond.mock.calls[0]?.[1] as SessionsForkResult | undefined,
      "fork response",
    );
    const childStorage = (docId: string) => ({ docId, scopeKey: result.sessionKey, stateDir });
    expect(await getWidgetStorageValue(childStorage(shown), "count")).toBe("3");
    expect(await getWidgetStorageValue(childStorage(later), "count")).toBeNull();

    await setWidgetStorageValue(childStorage(shown), "count", "4");
    expect(await getWidgetStorageValue(parentStorage(shown), "count")).toBe("3");
  });
});
