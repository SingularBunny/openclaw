import { describe, expect, it } from "vitest";
import {
  hashCliSessionResumeCompat,
  readCliSessionResumePoint,
  resumeCliSessionBindingsAt,
} from "./cli-session-binding.js";
import type { TranscriptEvent } from "./session-accessor.sqlite-contract.js";
import { planSessionMessageCut } from "./session-message-cut-plan.js";
import type { SessionMessageCutIntent } from "./session-message-cut.types.js";
import type { InternalSessionEntry } from "./types.js";

const account = {
  authProfileId: "anthropic:work",
  authEpoch: "auth-epoch-a",
  authEpochVersion: 2,
  cwdHash: "cwd-a",
};
const compat = hashCliSessionResumeCompat(account);

function assistant(id: string, parentId: string, point?: Record<string, unknown>) {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-11-01T00:00:00.000Z",
    message: {
      role: "assistant",
      content: [{ type: "text", text: id }],
      provider: "claude-cli",
      ...(point ? { __openclaw: { runId: `run-${id}`, cliResume: point } } : {}),
    },
  };
}

function user(id: string, parentId: string | null) {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-11-01T00:00:00.000Z",
    message: { role: "user", content: id },
  };
}

// u1 -> a1 (native-a@ckpt-1) -> u2 -> a2 (native-a@ckpt-2) -> u3 -> a3 (other provider)
const events: TranscriptEvent[] = [
  { type: "session", id: "local-1", version: 3, timestamp: "2026-11-01T00:00:00.000Z" },
  user("u1", null),
  assistant("a1", "u1", {
    provider: "claude-cli",
    sessionId: "native-a",
    checkpointId: "ckpt-1",
    compat,
  }),
  user("u2", "a1"),
  assistant("a2", "u2", {
    provider: "claude-cli",
    sessionId: "native-a",
    checkpointId: "ckpt-2",
    compat,
  }),
  user("u3", "a2"),
  assistant("a3", "u3"),
];

function entry(binding: Record<string, unknown>): InternalSessionEntry {
  return {
    sessionId: "local-1",
    lifecycleRevision: "rev-1",
    updatedAt: 1,
    cliSessionBindings: {
      "claude-cli": { sessionId: "native-b", ...account, ...binding },
      "other-cli": { sessionId: "other-native" },
    },
    cliSessionIds: { "claude-cli": "native-b", "other-cli": "other-native" },
    claudeCliSessionId: "native-b",
  } as InternalSessionEntry;
}

function intent(
  mode: SessionMessageCutIntent["mode"],
  entryId: string,
  cliForkProviders: string[] | undefined = ["claude-cli"],
): SessionMessageCutIntent {
  return {
    canonicalSourceKey: "agent:main:chat",
    entryId,
    expectedState: { sessionId: "local-1", lifecycleRevision: "rev-1" },
    mode,
    sourceKey: "agent:main:chat",
    targetKey: mode === "fork" ? "agent:main:chat-fork" : "agent:main:chat",
    ...(cliForkProviders ? { cliForkProviders } : {}),
  };
}

function plannedEntry(
  current: InternalSessionEntry,
  cutIntent: SessionMessageCutIntent,
  transcript: readonly TranscriptEvent[] = events,
) {
  const plan = planSessionMessageCut(current, transcript, cutIntent);
  if (plan.status !== "prepared") {
    throw new Error(`expected a prepared cut, got ${plan.status}`);
  }
  return plan.result.entry;
}

describe("message cuts keep native CLI continuity", () => {
  it("rewinds onto the kept branch's last checkpoint with a one-shot fork", () => {
    const next = plannedEntry(
      entry({ resumeCheckpointId: "ckpt-3", extraSystemPromptHash: "prompt" }),
      intent("rewind", "u2"),
    );

    expect(next.cliSessionBindings).toEqual({
      "claude-cli": expect.objectContaining({
        sessionId: "native-a",
        resumeCheckpointId: "ckpt-1",
        forkNextResume: true,
        ...account,
        extraSystemPromptHash: "prompt",
      }),
    });
    expect(next.cliSessionIds).toEqual({ "claude-cli": "native-a" });
    expect(next.claudeCliSessionId).toBeUndefined();
    expect(next.sessionId).not.toBe("local-1");
  });

  it("forks a per-message fork child at the cut point", () => {
    const next = plannedEntry(entry({}), intent("fork", "u3"));
    expect(next.cliSessionBindings?.["claude-cli"]).toMatchObject({
      sessionId: "native-a",
      resumeCheckpointId: "ckpt-2",
      forkNextResume: true,
    });
  });

  it("follows a branch switch to the selected tip's checkpoint", () => {
    // Active tip a2b; switch back to the a2 tip.
    const branched: TranscriptEvent[] = [
      ...events.slice(0, 5),
      user("u2b", "a1"),
      assistant("a2b", "u2b", {
        provider: "claude-cli",
        sessionId: "native-a",
        checkpointId: "ckpt-2b",
        compat,
      }),
    ];
    const next = plannedEntry(entry({}), intent("switch", "a2"), branched);
    expect(next.cliSessionBindings?.["claude-cli"]).toMatchObject({
      sessionId: "native-a",
      resumeCheckpointId: "ckpt-2",
      forkNextResume: true,
    });
  });

  it("starts fresh when the last kept assistant turn has no native checkpoint", () => {
    // Rewinding the next user turn keeps a3, written by another provider.
    const withTail = [...events, user("u4", "a3")];
    const next = plannedEntry(entry({}), intent("rewind", "u4"), withTail);
    expect(next.cliSessionBindings).toBeUndefined();
    expect(next.cliSessionIds).toBeUndefined();
  });

  it("starts fresh when the cut keeps no assistant turn", () => {
    expect(plannedEntry(entry({}), intent("rewind", "u1")).cliSessionBindings).toBeUndefined();
  });

  it("starts fresh when the backend cannot fork at a checkpoint", () => {
    expect(plannedEntry(entry({}), intent("rewind", "u2", [])).cliSessionBindings).toBeUndefined();
    expect(
      plannedEntry(entry({}), intent("rewind", "u2", ["other-cli"])).cliSessionBindings,
    ).toBeUndefined();
  });

  it("refuses an older native session from another account or workspace", () => {
    for (const changed of [
      { authProfileId: "anthropic:personal" },
      { authEpoch: "auth-epoch-b" },
      { cwdHash: "cwd-b" },
    ]) {
      expect(
        plannedEntry(entry(changed), intent("rewind", "u2")).cliSessionBindings,
      ).toBeUndefined();
    }
  });

  it("starts fresh when the chat has no current native binding", () => {
    const unbound = { ...entry({}), cliSessionBindings: undefined, cliSessionIds: undefined };
    expect(plannedEntry(unbound, intent("rewind", "u2")).cliSessionBindings).toBeUndefined();
  });
});

describe("CLI resume points", () => {
  it("accepts a point without a digest only inside the bound native session", () => {
    const imported = { provider: "claude-cli", sessionId: "native-thread", checkpointId: "uuid-1" };
    const attached = {
      cliSessionBindings: {
        "claude-cli": {
          sessionId: "native-thread",
          forceReuse: true,
          forkNextResume: true as const,
        },
      },
    };
    expect(resumeCliSessionBindingsAt(attached, imported, () => true)).toEqual({
      "claude-cli": {
        sessionId: "native-thread",
        resumeCheckpointId: "uuid-1",
        forceReuse: true,
        forkNextResume: true,
      },
    });
    const continued = {
      cliSessionBindings: { "claude-cli": { sessionId: "native-successor", ...account } },
    };
    expect(resumeCliSessionBindingsAt(continued, imported, () => true)).toBeUndefined();
  });

  it("drops an attachment's force-reuse trust for a different native session", () => {
    const bindings = resumeCliSessionBindingsAt(
      {
        cliSessionBindings: {
          "claude-cli": {
            sessionId: "native-b",
            forceReuse: true,
            reseedReceipt: undefined,
            ...account,
          },
        },
      },
      { provider: "claude-cli", sessionId: "native-a", checkpointId: "ckpt", compat },
      () => true,
    );
    expect(bindings?.["claude-cli"]).not.toHaveProperty("forceReuse");
    expect(bindings?.["claude-cli"]).toMatchObject({ sessionId: "native-a", forkNextResume: true });
  });

  it("reads only complete points from transcript metadata", () => {
    expect(
      readCliSessionResumePoint({
        __openclaw: {
          cliResume: { provider: "Claude-CLI", sessionId: " s ", checkpointId: "c", compat },
        },
      }),
    ).toEqual({ provider: "claude-cli", sessionId: "s", checkpointId: "c", compat });
    expect(
      readCliSessionResumePoint({
        __openclaw: { cliResume: { provider: "claude-cli", sessionId: "s", compat: "not-a-hash" } },
      }),
    ).toBeUndefined();
    expect(
      readCliSessionResumePoint({
        __openclaw: {
          cliResume: { provider: "claude-cli", sessionId: "s", checkpointId: "c", compat: "x" },
        },
      }),
    ).toEqual({ provider: "claude-cli", sessionId: "s", checkpointId: "c" });
    expect(readCliSessionResumePoint({ role: "assistant" })).toBeUndefined();
  });
});

describe("message cuts at rows from the CLI's own transcript", () => {
  const nativePoint = {
    provider: "claude-cli",
    sessionId: "native-b",
    checkpointId: "native-row-before",
  };

  it("resumes at a caller-read native checkpoint instead of the recorded one", () => {
    const plan = planSessionMessageCut(entry({}), events, {
      ...intent("rewind", "u3"),
      cliResumePoint: nativePoint,
    });
    expect(plan.status).toBe("prepared");
    if (plan.status !== "prepared") {
      return;
    }
    expect(plan.result.entry.cliSessionBindings?.["claude-cli"]).toMatchObject({
      sessionId: "native-b",
      resumeCheckpointId: "native-row-before",
      forkNextResume: true,
    });
    // A local row keeps its own composer text.
    expect(plan.result).toMatchObject({ editorText: "u3" });
  });

  it("cuts at the next local prompt and restores the native prompt text", () => {
    const plan = planSessionMessageCut(entry({}), events, {
      ...intent("rewind", "u3"),
      cliResumePoint: nativePoint,
      nativeCut: { editorText: "typed in Claude Code" },
    });
    expect(plan.status).toBe("prepared");
    if (plan.status !== "prepared") {
      return;
    }
    expect(plan.result).toMatchObject({ editorText: "typed in Claude Code" });
    expect(plan.events.at(-1)).toMatchObject({ type: "leaf", targetId: "a2" });
  });

  it("keeps the whole local branch when no local prompt follows the native row", () => {
    const plan = planSessionMessageCut(entry({}), events, {
      ...intent("rewind", "native-only-row"),
      cliResumePoint: nativePoint,
      nativeCut: { editorText: "typed later", keepLeaf: true },
    });
    expect(plan.status).toBe("prepared");
    if (plan.status !== "prepared") {
      return;
    }
    expect(plan.events.at(-1)).toMatchObject({ type: "leaf", targetId: "a3" });
    expect(plan.result).toMatchObject({ editorText: "typed later" });
    expect(plan.result.entry.sessionId).not.toBe("local-1");
    expect(plan.result.entry.cliSessionBindings?.["claude-cli"]).toMatchObject({
      resumeCheckpointId: "native-row-before",
    });

    const forked = planSessionMessageCut(entry({}), events, {
      ...intent("fork", "native-only-row"),
      cliResumePoint: nativePoint,
      nativeCut: { keepLeaf: true },
    });
    expect(forked.status).toBe("prepared");
    if (forked.status === "prepared") {
      expect(forked.events.slice(1).map((event) => (event as { id: string }).id)).toEqual([
        "u1",
        "a1",
        "u2",
        "a2",
        "u3",
        "a3",
      ]);
    }
  });

  it("never falls back to the newer recorded checkpoint for a native-only row", () => {
    const next = plannedEntry(entry({}), {
      ...intent("rewind", "native-only-row"),
      nativeCut: { keepLeaf: true },
    });
    expect(next.cliSessionBindings).toBeUndefined();
  });

  it("still reports a missing local anchor", () => {
    expect(
      planSessionMessageCut(entry({}), events, {
        ...intent("rewind", "gone"),
        nativeCut: {},
      }).status,
    ).toBe("missing-entry");
  });
});
