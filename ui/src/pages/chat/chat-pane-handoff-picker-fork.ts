// Fork: the composer's model picker also hands the chat to another model or an ACP agent (Junie), lists
// the bound agent's own models, and re-sends a failed turn to the chosen target. Kept out of
// chat-pane-session-controls.ts, an upstream file, so rebases touch only the wiring there.
import { t } from "../../i18n/index.ts";
import { publishChatGroupController } from "./chat-group-registry.ts";
import { createChatGroupController } from "./chat-group.ts";
import { pickerHandoffModel } from "./chat-handoff-resend-target.ts";
import {
  CHAT_HANDOFF_AGENT_GROUP_ID,
  CHAT_HANDOFF_AGENT_MODEL_GROUP_ID,
  canUseChatAcpModels,
  createChatHandoffController,
  ensureChatAcpModels,
  handOffChat,
  listChatHandoffModels,
  publishChatHandoffController,
  readChatAcpModels,
  recordChatPickerSwitch,
  refreshChatAcpModels,
  setChatAcpModel,
  setPendingResend,
  takePendingResend,
} from "./chat-handoff.ts";
import { switchChatModel } from "./chat-session.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { refreshChatModelCatalogOnDemand } from "./chat-state-refresh.ts";
import type { ChatModelPickerTargetGroup } from "./components/chat-model-picker-options.ts";

/** The picker's target groups carry a settled option list (upstream lazy loading). */
function withCompletion({
  status,
  ...group
}: Omit<ChatModelPickerTargetGroup, "completion"> & {
  status: "loading" | "error" | "ready";
}): ChatModelPickerTargetGroup {
  const promise =
    status === "ready"
      ? Promise.resolve(group.options)
      : status === "error"
        ? Promise.reject(new Error(group.errorLabel))
        : new Promise<ChatModelPickerTargetGroup["options"]>(() => {});
  // The picker owns the rejection; keep it from surfacing as unhandled.
  promise.catch(() => {});
  return { ...group, completion: { promise } };
}

/** Picker props and callbacks of the handoff; the caller keeps its own access checks. */
export function createChatHandoffPicker(params: {
  state: ChatPageHost;
  sessionKey: string;
  agentDefaultModel: string | undefined;
  ownsRoute: () => boolean;
}) {
  const { state, sessionKey, agentDefaultModel, ownsRoute } = params;
  // Model and agent switch buttons share one handoff controller per chat.
  // Fork state (handoff, group chat, plan mode) re-renders the controls through this revision.
  void state.forkUiRevision;
  const handoff = createChatHandoffController(state, { models: listChatHandoffModels(state) });
  publishChatHandoffController(handoff);
  // Group chat members ("Add to group chat", "Ask <name>") share the handoff's model list.
  publishChatGroupController(createChatGroupController(state, { models: handoff.models }));
  const boundAgent = handoff.info?.binding ? handoff.current : undefined;
  // While an ACP agent is bound, the picker lists that agent's models (`/acp model` by button).
  if (handoff.info?.binding && canUseChatAcpModels(state)) {
    ensureChatAcpModels(state, sessionKey);
  }
  const agentModels = handoff.info?.binding ? readChatAcpModels(state, sessionKey) : undefined;
  const agentModelLabel = (id: string) =>
    agentModels?.models.find((model) => model.id === id)?.name ?? id;
  const agentModelsGroup =
    boundAgent?.kind === "agent" &&
    agentModels &&
    (agentModels.status !== "ready" || agentModels.models.length > 0)
      ? {
          id: CHAT_HANDOFF_AGENT_MODEL_GROUP_ID,
          label: t("chat.handoff.agentModels", { agent: handoff.labelOf(boundAgent) }),
          options: agentModels.models.map((model) => ({
            label:
              model.id === agentModels.current
                ? t("chat.handoff.agentModelCurrent", { model: model.name ?? model.id })
                : (model.name ?? model.id),
            value: model.id,
          })),
          status: agentModels.status,
          errorLabel: t("chat.handoff.agentModelsUnavailable"),
        }
      : undefined;
  const pickerTargetGroups: ChatModelPickerTargetGroup[] = [
    ...(agentModelsGroup ? [withCompletion(agentModelsGroup)] : []),
    ...(handoff.agents.length > 0
      ? [
          withCompletion({
            id: CHAT_HANDOFF_AGENT_GROUP_ID,
            label: t("chat.handoff.agentsGroup"),
            options: handoff.agents.map((agent) => ({
              label: agent.label,
              value: agent.answerer.kind === "agent" ? agent.answerer.agent : "",
            })),
            status: "ready" as const,
            errorLabel: "",
          }),
        ]
      : []),
  ];
  return {
    pickerProps: {
      modelPickerTargetGroups: pickerTargetGroups.length > 0 ? pickerTargetGroups : undefined,
      modelPickerTriggerLabel:
        boundAgent?.kind === "agent"
          ? agentModels?.current
            ? t("chat.handoff.agentModelTrigger", {
                agent: handoff.labelOf(boundAgent),
                model: agentModelLabel(agentModels.current),
              })
            : t("chat.handoff.agentTrigger", { agent: handoff.labelOf(boundAgent) })
          : undefined,
      onModelPickerTargetSelect: (groupId: string, value: string): Promise<boolean> => {
        if (!ownsRoute()) {
          return Promise.resolve(false);
        }
        if (groupId === CHAT_HANDOFF_AGENT_MODEL_GROUP_ID) {
          return setChatAcpModel(state, value, sessionKey);
        }
        return groupId === CHAT_HANDOFF_AGENT_GROUP_ID
          ? handOffChat(
              state,
              { kind: "agent", agent: value },
              { resend: takePendingResend(state, sessionKey) },
            )
          : Promise.resolve(false);
      },
      onModelPickerOpen: () => {
        // The bound agent may have advertised other models since the last read.
        if (handoff.info?.binding && canUseChatAcpModels(state)) {
          void refreshChatAcpModels(state, sessionKey);
        }
        return refreshChatModelCatalogOnDemand(state);
      },
    },
    /** A choice in the closing picker takes the pending re-send first. */
    onPickerClosed: () => {
      setTimeout(() => setPendingResend(state, sessionKey, undefined), 0);
    },
    /** Bound to an agent, or re-sending a failed turn: unbind first, then switch and send. */
    selectModel: (
      next: string,
      targetSessionKey: string | undefined,
      agentRuntime: string | null | undefined,
    ): Promise<boolean> => {
      const resend = takePendingResend(state, sessionKey);
      const handoffModel = pickerHandoffModel(next, {
        bound: Boolean(handoff.info?.binding),
        resend,
        defaultModel: agentDefaultModel,
      });
      if (handoffModel) {
        return handOffChat(
          state,
          { kind: "model", model: handoffModel, ...(agentRuntime ? { agentRuntime } : {}) },
          { resend },
        );
      }
      const previous = handoff.current;
      return switchChatModel(state, next, targetSessionKey, agentRuntime, agentDefaultModel).then(
        (switched) => {
          if (switched && next) {
            void recordChatPickerSwitch(state, sessionKey, previous, next);
          }
          return switched;
        },
      );
    },
  };
}
