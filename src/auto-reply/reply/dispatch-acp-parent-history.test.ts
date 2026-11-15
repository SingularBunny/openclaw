import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { makeUserMessage } from "../../../test/helpers/user-message.js";
import { buildAssistantMessage, buildUsageWithNoCost } from "../../agents/stream-message-shared.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  appendTranscriptMessage,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { PROGRESS_CARD_REFRESH_SOURCE_TOOL } from "../../sessions/input-provenance.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { buildAcpParentHistoryPrompt } from "./dispatch-acp-parent-history.runtime.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    for (const stateDir of tempDirs.dirs) {
      await cleanupSessionStateForTest({ stateDir });
    }
    cleanup();
  });
});

const parentKey = "agent:main:main";
const childKey = "agent:main:acp:child";

async function createChat() {
  const dir = tempDirs.make("openclaw-acp-parent-history-");
  const storePath = path.join(dir, "openclaw-agent.sqlite");
  const cfg = { session: { store: storePath } } as OpenClawConfig;
  const parent = { agentId: "main", sessionId: "parent-session", sessionKey: parentKey, storePath };
  const child = { agentId: "main", sessionId: "child-session", sessionKey: childKey, storePath };
  await upsertSessionEntryCore(parent, { sessionId: parent.sessionId, updatedAt: 1 });
  await upsertSessionEntryCore(child, { sessionId: child.sessionId, updatedAt: 1 });
  let seq = 0;
  const user = async (target: typeof parent, text: string, now: number, extra = {}) =>
    await appendTranscriptMessage(target, {
      eventId: `user-${++seq}`,
      now,
      message: { ...makeUserMessage(text, now), ...extra },
    });
  const assistant = async (target: typeof parent, text: string, now: number, model: string[]) =>
    await appendTranscriptMessage(target, {
      eventId: `assistant-${++seq}`,
      now,
      message: buildAssistantMessage({
        model: { api: "cli", provider: model[0]!, id: model[1]! },
        content: [{ type: "text", text }],
        stopReason: "stop",
        usage: buildUsageWithNoCost({}),
      }),
    });
  const build = async (prompt: string) =>
    await buildAcpParentHistoryPrompt({
      cfg,
      parentSessionKey: parentKey,
      child: { agentId: "main", sessionKey: childKey, sessionId: child.sessionId },
      acpAgent: "codex",
      prompt,
    });
  return { parent, child, user, assistant, build };
}

describe("ACP parent chat history (F72)", () => {
  it("seeds the whole chat on the first prompt and only other models' turns later", async () => {
    const { parent, child, user, assistant, build } = await createChat();
    expect(await build("Hello")).toBeUndefined();
    await user(parent, "Plan the migration.", 1_000);
    await assistant(parent, "Step one: freeze writes.", 2_000, ["claude-cli", "claude-opus"]);
    await user(parent, "Refresh the card.", 2_500, {
      provenance: { kind: "internal_system", sourceTool: PROGRESS_CARD_REFRESH_SOURCE_TOOL },
    });
    await assistant(parent, "mirror only", 2_600, ["openclaw", "gateway-injected"]);
    // The current input is already in the parent chat.
    await user(parent, "Continue from step one.", 3_000);

    const first = await build("Continue from step one.");
    expect(first).toContain("User: Plan the migration.");
    expect(first).toContain("Assistant: Step one: freeze writes.");
    expect(first).not.toContain("Refresh the card.");
    expect(first).not.toContain("mirror only");
    expect(first).toContain("<next_user_message>\nContinue from step one.\n</next_user_message>");
    expect(first?.match(/Continue from step one\./g)).toHaveLength(1);

    // The ACP session records its own turn; the parent mirrors the reply as ACP output.
    await user(child, "Continue from step one.", 3_100);
    await assistant(child, "Codex: step two done.", 4_000, ["openclaw", "acp-runtime"]);
    await assistant(parent, "Codex: step two done.", 4_100, ["acp", "codex"]);
    expect(await build("Next?")).toBeUndefined();

    // Another model answered in the chat meanwhile: only that delta is sent.
    await user(parent, "Gemini, review step two.", 5_000);
    await assistant(parent, "Looks fine.", 6_000, ["google", "gemini-pro"]);
    await user(parent, "Codex, step three.", 7_000);
    const delta = await build("Codex, step three.");
    expect(delta).toContain("User: Gemini, review step two.");
    expect(delta).toContain("Assistant: Looks fine.");
    expect(delta).not.toContain("Plan the migration.");
    expect(delta).not.toContain("Codex: step two done.");
    expect(delta?.match(/Codex, step three\./g)).toHaveLength(1);
  });
});
