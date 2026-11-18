import { describe, expect, it } from "vitest";
import { createActiveSessionPlacement } from "../../test-helpers/session-placement.ts";
import { resolveChatModelSetup, requiresChatModelSetup } from "./chat-model-setup.ts";

type ModelSetup = Parameters<typeof resolveChatModelSetup>[0];

const loaded = {
  catalog: false,
  connected: true,
  agentsLoaded: true,
  selectedAgentFound: true,
};

it.each([
  ["missing model route", {}, true],
  ["configured model", { agentModel: "openai/gpt-5.4" }, false],
  ["unresolved agent", { agentsLoaded: false, selectedAgentFound: false }, false],
] as const)("requiresChatModelSetup: %s", (_name, overrides, required) => {
  expect(requiresChatModelSetup({ ...loaded, ...overrides })).toBe(required);
});

const active = createActiveSessionPlacement({
  environmentId: "worker:test",
  workspaceBaseManifestRef: "workspace-base",
  remoteWorkspaceDir: "/worker/workspace",
  inference: "worker" as const,
});

it.each(["missing-auth", "auth-failed"] as const)(
  "ignores only Gateway provider credentials for a current worker placement (%s)",
  (unavailableReason) => {
    const catalog = [
      {
        id: "gpt-4.1-mini",
        name: "GPT-4.1 mini",
        provider: "openai",
        available: false,
        unavailableReason,
      },
    ];
    const session = {
      key: "agent:main:worker-test",
      kind: "direct" as const,
      updatedAt: 1,
      model: "gpt-4.1-mini",
      modelProvider: "openai",
    };
    const banner = (
      placement?: NonNullable<ModelSetup["activeSession"]>["placement"],
      overrides: Partial<ModelSetup> = {},
    ) =>
      resolveChatModelSetup({
        ...loaded,
        agentModel: "openai/gpt-4.1-mini",
        chatModelCatalog: catalog,
        modelOverrides: {},
        sessionKey: "agent:main:worker-test",
        sessionsResult: null,
        catalogError: null,
        onSetup: () => undefined,
        activeSession: { ...session, placement },
        ...overrides,
      }).modelUnavailableBanner;
    expect(banner()).toBeDefined();
    expect(banner(active)).toBeUndefined();
    expect(
      banner(active, {
        activeSession: {
          ...session,
          modelOverrideSource: "user",
          placement: active,
        },
      }),
    ).toBeUndefined();
    expect(banner(active, { catalogRetired: true })).toBeDefined();
    expect(
      banner(active, {
        modelSelectionPolicy: { restricted: true, defaultModel: null },
        chatModelCatalog: [],
      }),
    ).toBeDefined();
    expect(banner({ ...active, state: "reclaimed" })).toBeDefined();
    expect(banner({ ...active, state: "local" })).toBeDefined();
    const { inference: _inference, ...proxied } = active;
    expect(banner(proxied)).toBeDefined();
  },
);

describe("Claude CLI login banner", () => {
  const setup = (provider: string, unavailableReason: "missing-auth" | "auth-failed") => {
    const onSetup = () => undefined;
    const result = resolveChatModelSetup({
      catalog: false,
      connected: true,
      agentsLoaded: true,
      selectedAgentFound: true,
      agentModel: `${provider}/claude-opus-5-5`,
      chatModelCatalog: [
        { id: "claude-opus-5-5", name: "Opus", provider, available: false, unavailableReason },
      ],
      modelOverrides: {},
      sessionKey: "agent:main:main",
      sessionsResult: null,
      catalogError: null,
      onSetup,
      activeSession: {
        key: "agent:main:main",
        kind: "direct",
        updatedAt: 1,
        model: "claude-opus-5-5",
        modelProvider: provider,
      },
    });
    return { banner: result.modelUnavailableBanner, onSetup };
  };

  it("names the expired Claude subscription login and opens Model Setup", () => {
    const { banner, onSetup } = setup("claude-cli", "missing-auth");
    expect(banner?.text).toContain("not signed in to your Claude account");
    expect(banner?.text).toContain("claude auth login");
    expect(banner?.text).not.toContain("No provider credential");
    expect(banner?.actionLabel).toBe("Open Model Setup");
    expect(banner?.onAction).toBe(onSetup);
  });

  it("keeps the generic credential copy for other providers and other reasons", () => {
    expect(setup("anthropic", "missing-auth").banner?.text).toContain("No provider credential");
    expect(setup("claude-cli", "auth-failed").banner?.text).not.toContain("claude auth login");
  });
});
