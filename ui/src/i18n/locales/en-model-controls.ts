import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enModelControls = {
  chat: {
    // Fork: switching who answers a chat by buttons (models and ACP agents).
    handoff: {
      agentsGroup: "Agents",
      agentTrigger: "{agent} · agent",
      answering: "{current} is answering",
      returnTo: "Return to {previous}",
      dismiss: "Hide",
      handOff: "Hand off to…",
      handOffTitle: "Hand off this reply's question to another model or agent",
      models: "Models",
      agents: "Agents",
      longContext:
        "Long chat: the new model or agent reads it without a warm prompt cache, which is slower and costs more.",
      failed: "Could not hand off to {target}: {reason}",
      offline: "the Gateway is not connected.",
      closeFailed: "{agent} is still bound to this chat.",
      agentNotAllowed: "{agent} is not in acp.allowedAgents.",
      bindFailed: "the agent was not bound; the /acp reply in the chat says why.",
      modelFailed: "the model could not be selected.",
      retry: "Retry",
      retryTitle: "Send the same message to the same model again",
      chooseAnotherModel: "Choose another model",
      writtenBy: "Written by {author}",
      agentModels: "{agent} models",
      agentModelCurrent: "{model} · current",
      agentModelTrigger: "{agent} · {model}",
      agentModelsUnavailable: "The agent's models could not be read.",
      agentModelFailed: "Could not set the agent's model to {model}: {reason}",
    },
    // Fork: the composer's Plan toggle (workbench plan mode, the same switch as /plan).
    planMode: {
      label: "Plan mode",
      on: "Plan",
      turnOn:
        "Plan mode is off. Turn it on: the agent researches and presents a plan before changing anything.",
      turnOff: "Plan mode is on: files stay unchanged until you approve the plan. Turn it off.",
      readOnly: "Changing plan mode needs operator write access.",
      updateFailed: "Could not change plan mode: {error}",
    },
    // Fork: chat commands as items of the chat's menu.
    commandMenu: {
      new: "New chat",
      newUnavailable: "New chat is unavailable here.",
      reset: "Reset chat…",
      resetConfirmTitle: "Reset this chat?",
      resetConfirmMessage:
        "The agent starts a fresh session in this chat and no longer sees the earlier conversation. This is the same as /reset.",
      resetConfirm: "Reset chat",
      learn: "Learn a skill from this chat",
      learnDescription: "Saves the reusable workflow from this chat as a skill (/learn).",
      offline: "The Gateway is not connected.",
    },
    modelControls: {
      subscription: "Subscription",
      api: "API",
      default: "Default",
      routes: {
        claudeCli: {
          label: "Claude CLI · native",
          detail:
            "Runs through Claude Code, using its native login or a selected saved account. An explicitly selected API-key account has separate API billing; CLI does not mean free or subscription-only.",
        },
        anthropicApi: {
          label: "API · OpenClaw",
          detail:
            "Uses the configured Anthropic API connection with OpenClaw's runtime. API-key usage is billed separately from a Claude subscription.",
        },
        anthropicConfigured: {
          label: "Configured route",
          detail:
            "Anthropic models can use the API or Claude CLI, depending on their configured runtime and account. The provider name alone does not determine billing.",
        },
      },
      completionRoutes: {
        api: {
          label: "API · OpenClaw",
          detail:
            "Uses the provider's API connection with OpenClaw's runtime. API usage is billed to that provider account.",
        },
        cli: {
          label: "{runtime} · native",
          detail:
            "Runs through {runtime} using its own login. Billing follows the account it is signed in with; an API-key login is billed as API usage.",
        },
        harness: {
          label: "{runtime}",
          detail: "Runs through the {runtime} agent runtime and the account it uses.",
        },
      },
      decisionLabel: "Decision Model",
      decisionDisabled: "Disabled",
      decisionInherit: "Use global default · {model}",
      decisionUnavailable:
        "This decision model is unavailable. Enable its plugin or choose another model.",
      decisionHelp:
        "Makes typed choices, scores, and yes/no judgments. Disabled until you select a decision model; chat models are not used as a fallback.",
      decisionAgentHelp:
        "Use the global decision model, choose an override, or disable decisions for this agent.",
      effort: "Effort",
      faster: "Faster",
      smarter: "Smarter",
      fastMode: "Fast mode",
      speed: "Speed",
      standard: "Standard",
      daybreak: "Daybreak",
      daybreakBlueShort: "Blue",
      daybreakRedShort: "Red",
      daybreakBlue: "Daybreak Blue",
      daybreakRed: "Daybreak Red",
      access: "Access",
      accessUnavailable: "{program} (unavailable)",
      fast: "Fast",
      ultrafast: "Ultrafast",
      ultrafastUnavailable: "Ultrafast is not available for this model",
      tierDowngrade: "{requested} requested, currently served as {served}",
      tierRejected: "{requested} requested, currently unavailable",
      switchTitle: "Switch to {new}?",
      switchWarning:
        "This conversation is cached for {current}. Switching models means it reprocesses the whole conversation on your next message, which can spend more tokens. Longer conversations may also be compacted.",
      switchConfirm: "Switch model",
      dontAskAgain: "Don’t ask again",
      searchModels: "Search models",
      noMatchingModels: "No models match your search",
      configureModels: "Configure models",
      selectionScopeSessionLabel: "This session",
      selectionScopeAgentLabel: "Agent default",
      selectionScopeGlobalLabel: "Global default",
      selectionScopeSession: "Selecting a model changes only this session.",
      selectionScopeAgent: "Selecting a model updates this agent's default.",
      selectionScopeGlobal: "Selecting a model updates the global default.",
      defaultWithModel: "Default ({model})",
      defaultWithLevel: "Default ({level})",
      fastHelp: "Faster responses, higher usage of limits.",
      contextWindow: "Context window",
      contextWindowAria: "Context window: {state}",
      speedUnsupported: "Speed control is not supported for this model.",
      contextActiveAndMax: "{active} active · {maximum} max",
      chatOnly: "Chat only",
      chatOnlyHelp:
        "This model can chat, but it cannot use tools. Choose another model for files, commands, web, or media tasks.",
      loadingModels: "Loading models…",
      refreshingModels: "Refreshing models…",
      refreshingSettings: "Refreshing session settings…",
      refreshingProviderModels: "Refreshing models for {providers}…",
      modelPending: "Model pending",
      modelsUnavailable: "Models unavailable",
      runtimeUnavailable: "This harness is unavailable for this model.",
      modelsRefreshFailed: "Some models could not be refreshed. Open Models to try again.",
      checkingProviderModels: "{providers}: checking models…",
      noModelsAvailable: "No models available",
      claudeCliNotReady: "Claude Code isn't ready. If signed out, run claude auth login.",
      noPermittedModels: "No models are permitted by your administrator.",
      selectionRequired: "Choose a model",
      restrictedModelsHelp: "Your administrator centrally configures the models available here.",
      emptyModelsAction: "Manage models",
      providerModels: "{provider} models",
      allModels: "All models ({count})",
      useDefaultReasoning: "Use default reasoning ({level})",
      fastResponsesAria: "Fast responses: {state}",
    },
    nativeRuntimeRecovery: {
      title: "Use {runtime}’s native permissions?",
      confirm: "Continue for this chat",
      confirmMessage:
        "{runtime} will run on the Gateway host under its own permissions. OpenClaw’s optional native tool and sandbox restrictions, including workspace-only restrictions, will not be enforced for this harness. Only this chat is changed; other chats and global configuration stay unchanged. OpenClaw-hosted tools keep their own policy checks.",
      retryMessage: "Continue will retry the message you just sent.",
      chooseAnother: "Choose another model to keep this chat’s current execution restrictions.",
      failed: "Could not change this chat’s execution permissions: {error}",
      refreshFailed:
        "The model and permissions were saved, but refreshing this chat failed: {error}",
      reasons: {
        "sandbox-required": "{runtime} cannot run because this chat requires a sandbox.",
        sandbox: "{runtime} uses native tools that cannot run inside the OpenClaw sandbox.",
        "workspace-only":
          "{runtime} cannot enforce this chat’s OpenClaw workspace-only restriction.",
        "permission-mode": "{runtime} cannot enforce this chat’s current execution permissions.",
        "tool-policy": "{runtime} cannot enforce this chat’s OpenClaw native tool restrictions.",
        "remote-execution": "{runtime} cannot use this chat’s remote execution target.",
      },
    },
    permissionControls: {
      label: "Execution permissions",
      help: "Choose what available tools may do in this session. This does not change the tool profile.",
      default: "Default",
      defaultDescription: "The agent's configured permissions.",
      defaultWithMode: "Default ({mode})",
      fullRequiresAdmin: "Full access requires operator.admin access.",
      requiresAdmin: "Requires admin access.",
      updateFailed: "Failed to update permissions: {error}",
      refreshFailed: "Permissions were saved, but refreshing the session failed: {error}",
      modes: {
        "read-only": {
          label: "Read Only",
          description:
            "Agent tools can read within the session root, but cannot write or run commands.",
        },
        guarded: {
          label: "Guarded",
          description: "A human reviews requests beyond the session root.",
        },
        workspace: {
          label: "Workspace",
          description: "An AI reviewer checks requests beyond the session root.",
        },
        full: {
          label: "Full Access",
          description: "No reviewer; files and commands are unrestricted.",
        },
      },
    },
  },
} satisfies TranslationMap;

export const registerModelControlsEnglish = Object.assign(
  () => {
    en.chat = Object.assign({}, en.chat, enModelControls.chat);
  },
  { catalog: enModelControls },
);
