import type { GatewaySessionRow } from "../../api/types.ts";
import type { ApplicationGatewaySnapshot } from "../../app/gateway.ts";
import { t } from "../../i18n/index.ts";
import { registerModelControlsEnglish } from "../../i18n/locales/en-model-controls.ts";
import { storedChatOutboxScopeKey } from "../../lib/chat/outbox-store.ts";
import {
  readSessionMethodAccess,
  readSessionMethodScopeAccess,
  type SessionMethodAccess,
} from "../../lib/session-method-access.ts";
import { parseCatalogSessionKey } from "../../lib/sessions/catalog-key.ts";
import type { SessionPatch } from "../../lib/sessions/index.ts";
import {
  scopedAgentListParamsForSession,
  scopedAgentParamsForSession,
} from "../../lib/sessions/navigation.ts";
import { areUiSessionKeysEquivalent } from "../../lib/sessions/session-key.ts";
import { buildChatClaudeModePicker } from "./chat-claude-mode-controls.ts";
import { captureChatConnectionOwner } from "./chat-connection-owner.ts";
import { projectChatFields } from "./chat-field-projection.ts";
import { getAcceptedChatHistorySession, isChatSessionProvenAbsent } from "./chat-history-state.ts";
import { publishChatGroupController } from "./chat-group-registry.ts";
import { createChatGroupController } from "./chat-group.ts";
import { pickerHandoffModel } from "./chat-handoff-resend-target.ts";
import { ChatPaneModelControl } from "./chat-pane-model-control.tsx";
import {
  CHAT_HANDOFF_AGENT_GROUP_ID,
  CHAT_HANDOFF_AGENT_MODEL_GROUP_ID,
  canUseChatAcpModels,
  createChatHandoffController,
  ensureChatAcpModels,
  readChatAcpModels,
  refreshChatAcpModels,
  setChatAcpModel,
  handOffChat,
  listChatHandoffModels,
  publishChatHandoffController,
  recordChatPickerSwitch,
  setPendingResend,
  takePendingResend,
} from "./chat-handoff.ts";
import { getAcceptedChatHistorySession } from "./chat-history-state.ts";
import { ChatPaneModelControl } from "./chat-pane-model-control.tsx";
import { buildChatPlanModeToggle } from "./chat-plan-mode.ts";
import { readChatSessionActionAccess } from "./chat-session-action-access.ts";
import { switchChatModel, switchChatSetting } from "./chat-session.ts";
import { patchChatSessionSettings } from "./chat-settings-patches.ts";
import type { ChatState } from "./chat-state-contract.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import {
  readChatModelCatalogState,
  refreshChatModelCatalogOnDemand,
} from "./chat-state-refresh.ts";
import { selectedChatSessionRow } from "./chat-state-route.ts";
import type { ChatProps } from "./chat-view.tsx";
import type { ChatClaudeModePickerProps } from "./components/chat-claude-mode.ts";
import { renderChatModelAccountControl } from "./components/chat-model-account-control.ts";
import type { ChatModelPickerTargetGroup } from "./components/chat-model-picker-options.ts";
import type { ChatPermissionPickerProps } from "./components/chat-permission-picker.tsx";
import type { ChatPlanModeToggleProps } from "./components/chat-plan-mode-toggle.types.ts";
import { activeQueuedMessageEdit } from "./queued-message-edit.ts";
import { readChatSessionSnapshot } from "./session-message-cache.ts";

registerModelControlsEnglish();

/** Fork: the picker's target groups carry a settled option list (upstream lazy loading). */
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

type SessionActionAccess = ReturnType<typeof readChatSessionActionAccess>;
type SessionAction = keyof SessionActionAccess;
type SessionActionCallbacks = Pick<
  ChatProps,
  "onAbort" | "onCompact" | "onForkMessage" | "onRewindMessage"
>;
type ChatRewindChoice = Parameters<NonNullable<ChatProps["onRewindMessage"]>>[1];

type PendingPermissionChange = {
  expectedSessionId?: string;
  nextMode: ChatPermissionPickerProps["mode"];
  ownsSelection: () => boolean;
  retainWhileCurrent?: () => boolean;
};

type PermissionSelection = {
  pending: PendingPermissionChange | undefined;
  outcome: symbol | undefined;
};

const permissionSelections = new WeakMap<ChatPageHost, Map<string, PermissionSelection>>();

export function createChatPaneQueuedEditProps(
  state: ChatPageHost,
  sessionParticipationBlocked: boolean,
): NonNullable<ChatProps["queuedEdit"]> {
  const edit = activeQueuedMessageEdit(state);
  return {
    editingId: edit?.id ?? null,
    editingText: edit?.draftText,
    editingMentions: edit?.mentions,
    source: edit?.source,
    onEdit: sessionParticipationBlocked ? undefined : state.editQueuedChatMessage,
    onEditChange: sessionParticipationBlocked ? undefined : state.updateQueuedChatMessageEdit,
    onEditSubmit: sessionParticipationBlocked ? undefined : state.submitQueuedChatMessageEdit,
    onCancel: state.cancelQueuedChatMessageEdit,
  };
}

export function readChatPaneMutationAccess(
  snapshot: ApplicationGatewaySnapshot,
  sessionKey: string,
  session?: GatewaySessionRow,
  sessionAbsent = false,
) {
  const scopedPatchAccess = (patch: SessionPatch) =>
    readSessionMethodAccess(snapshot, {
      method: "sessions.patch",
      params: { key: sessionKey, ...patch },
      sessionScope: true,
      session,
    });
  return {
    composeScope: readSessionMethodScopeAccess(snapshot.hello?.auth, {
      method: "chat.send",
      requiredScope: "operator.write",
      sessionScope: true,
      session,
      sessionAbsent,
    }),
    model: scopedPatchAccess({ model: null }),
    effort: scopedPatchAccess({ thinkingLevel: null }),
    contextWindow: readSessionMethodAccess(snapshot, {
      method: "sessions.patch",
      params: { key: sessionKey, contextWindow: null },
    }),
    permission: scopedPatchAccess({ permissionMode: "guarded" }),
    unarchive: scopedPatchAccess({ archived: false }),
    pendingInputDismiss: readSessionMethodAccess(snapshot, {
      method: "chat.pendingInputs.dismiss",
      requiredScope: "operator.sessions.write",
      session,
    }),
  };
}

/** Without a row, only a read that proved the routed session absent admits its first turn. */
export function readChatPaneRouteMutationAccess(
  snapshot: ApplicationGatewaySnapshot,
  state: ChatState,
  session?: GatewaySessionRow,
) {
  return readChatPaneMutationAccess(
    snapshot,
    state.sessionKey,
    session,
    !session && isChatSessionProvenAbsent(state),
  );
}

export function canDismissChatPendingInputs(
  access: ReturnType<typeof readChatPaneMutationAccess>,
  session: Pick<GatewaySessionRow, "sharingRole"> | undefined,
  options: { nativeConversation: boolean; participationBlocked: boolean },
): boolean {
  return (
    access.pendingInputDismiss.allowed &&
    session?.sharingRole !== "viewer" &&
    options.nativeConversation &&
    !options.participationBlocked
  );
}

export function renderChatPaneComposerControls(params: {
  state: ChatPageHost;
  selectedSession: GatewaySessionRow | undefined;
  agentDefaultModel: string | undefined;
  agentDefaultPermissionMode?: ChatPermissionPickerProps["defaultMode"];
  modelAccess: SessionMethodAccess;
  effortAccess: SessionMethodAccess;
  contextWindowAccess: SessionMethodAccess;
  permissionAccess: SessionMethodAccess;
  canSelectFull: boolean;
  onModelSetup: () => void;
  onProviderSettings?: (provider: string) => void;
  onModelAccounts?: () => void;
}): {
  composerControls: Parameters<typeof ChatPaneModelControl>[0] & {
    component: typeof ChatPaneModelControl;
  };
  permissionPicker: ChatPermissionPickerProps;
  claudeModePicker?: ChatClaudeModePickerProps;
  planModeToggle?: ChatPlanModeToggleProps;
} {
  const {
    state,
    selectedSession,
    agentDefaultModel,
    agentDefaultPermissionMode,
    modelAccess,
    effortAccess,
    contextWindowAccess,
    permissionAccess,
    canSelectFull,
    onModelSetup,
    onProviderSettings,
    onModelAccounts,
  } = params;
  void state.accessPreferenceRevision;
  state.accessPreferences?.synchronize();
  const sessionKey = state.sessionKey;
  const preferenceAgentId = scopedAgentListParamsForSession(state, sessionKey).agentId;
  const client = state.client;
  const accountSelection = state.chatAccountSelection;
  const connectionIsCurrent = captureChatConnectionOwner(state);
  const agentScope = scopedAgentParamsForSession(state, sessionKey);
  const affectedAgentId = scopedAgentListParamsForSession(state, sessionKey).agentId;
  const expectedSessionId = selectedSession?.sessionId?.trim();
  const permissionScopeKey = JSON.stringify([sessionKey, agentScope.agentId]);
  const selections = permissionSelections.get(state) ?? new Map<string, PermissionSelection>();
  permissionSelections.set(state, selections);
  const selection =
    selections.get(permissionScopeKey) ??
    projectChatFields<PermissionSelection>({ pending: undefined, outcome: undefined }, ["pending"]);
  selections.set(permissionScopeKey, selection);
  const ownsRoute = () =>
    connectionIsCurrent() &&
    state.sessionKey === sessionKey &&
    scopedAgentParamsForSession(state, sessionKey).agentId === agentScope.agentId;
  const ownsSelection = () => {
    const currentSession = selectedChatSessionRow(state);
    return (
      ownsRoute() &&
      Boolean(currentSession) === Boolean(selectedSession) &&
      currentSession?.sessionId === expectedSessionId
    );
  };
  const canPatch = (patch: SessionPatch, targetSessionKey = sessionKey) =>
    areUiSessionKeysEquivalent(targetSessionKey, sessionKey) &&
    ownsSelection() &&
    readSessionMethodAccess(
      {
        client: state.client,
        hello: state.hello,
        phase: state.connected ? "connected" : "offline",
      },
      {
        method: "sessions.patch",
        params: { key: sessionKey, ...patch },
        sessionScope: true,
        session: selectedChatSessionRow(state),
      },
    ).allowed;
  const pendingChange = selection.pending;
  const currentChange =
    pendingChange?.expectedSessionId === expectedSessionId &&
    pendingChange?.ownsSelection() &&
    (!pendingChange.retainWhileCurrent || pendingChange.retainWhileCurrent())
      ? pendingChange
      : undefined;
  const permissionPending = Boolean(
    (currentChange && !currentChange.retainWhileCurrent) || selectedSession?.permissionModePending,
  );
  const modelCatalogState = readChatModelCatalogState(state);
  const accessProgramAccess = readSessionMethodAccess(
    { client: state.client, hello: state.hello, phase: state.connected ? "connected" : "offline" },
    {
      method: "sessions.patch",
      params: { key: sessionKey, cyberAccessProgram: null },
      sessionScope: true,
      session: selectedSession,
    },
  );
  const thinkingLevelOverride = state.sessions.think(sessionKey, agentScope.agentId);
  const settingsPreview = state.sessions.settingsPreview(sessionKey, agentScope.agentId);
  const settingsSession =
    thinkingLevelOverride || settingsPreview
      ? {
          ...selectedSession,
          ...(thinkingLevelOverride ? { thinkingLevel: thinkingLevelOverride } : {}),
          ...settingsPreview,
        }
      : selectedSession;
  const sessionReady =
    state.connected &&
    selectedSession &&
    (!state.sessions.state.resultCached || getAcceptedChatHistorySession(state));
  const snapshot =
    sessionReady && state.chatModelCatalogInitialized
      ? undefined
      : (readChatSessionSnapshot(state.chatMessagesBySession, state, { sessionKey })?.composer ??
        undefined);
  const permissionSnapshot = sessionReady ? undefined : snapshot;
  const snapshotReason = snapshot ? t("chat.modelControls.refreshingSettings") : undefined;
  // Fork: model and agent switch buttons share one handoff controller per chat.
  // Fork state (handoff, group chat, plan mode) re-renders the controls through this revision.
  void state.forkUiRevision;
  const handoff = createChatHandoffController(state, { models: listChatHandoffModels(state) });
  publishChatHandoffController(handoff);
  // Fork: group chat members ("Add to group chat", "Ask <name>") share the handoff's model list.
  publishChatGroupController(createChatGroupController(state, { models: handoff.models }));
  const boundAgent = handoff.info?.binding ? handoff.current : undefined;
  // Fork: while an ACP agent is bound, the picker lists that agent's models (`/acp model` by button).
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
    composerControls: {
      component: ChatPaneModelControl,
      model: {
        snapshot,
        modelAuthStatusResult: state.modelAuthStatusResult,
        accountSelection,
        renderAccountSection: (accountModel) =>
          renderChatModelAccountControl({
            owner: state,
            client,
            selection: accountSelection,
            modelAuthStatusResult: state.modelAuthStatusResult,
            model: accountModel,
            disabled:
              !modelAccess.allowed ||
              !state.connected ||
              !accountModel ||
              selectedSession?.modelSelectionLocked === true ||
              state.chatLoading ||
              state.chatSending ||
              Boolean(state.chatRunId) ||
              state.chatStream !== null ||
              Boolean(state.chatModelSwitchPromises[sessionKey]),
            ownsSelection: () => ownsSelection() && state.chatAccountSelection === accountSelection,
            onSelect: (account) =>
              modelAccess.allowed && canPatch({ model: `${accountModel}@${account.authProfileId}` })
                ? switchChatModel(state, `${accountModel}@${account.authProfileId}`, sessionKey)
                : Promise.resolve(false),
            onManage: onModelAccounts,
          }),
        activeRunId: state.chatRunId,
        agentDefaultModel,
        connected: state.connected,
        gatewayAvailable: Boolean(state.client),
        loading: state.chatLoading,
        modelCatalog: state.chatModelCatalog,
        modelCatalogState,
        modelOverrides: state.sessions.state.modelOverrides,
        thinkingSession: settingsSession,
        fastModeTarget: settingsSession,
        accessProgramMutationDisabledReason: accessProgramAccess.allowed
          ? undefined
          : accessProgramAccess.reason,
        requestedAccessProgram: settingsSession?.cyberAccessProgram,
        daybreakAccessProgram: state.accessPreferences?.readPreference(preferenceAgentId ?? "main")
          ?.daybreakAccessProgram,
        contextWindowTarget: settingsPreview
          ? { ...(selectedSession ?? state.sessionsResult?.defaults), ...settingsPreview }
          : undefined,
        modelSelectionLocked: selectedSession?.modelSelectionLocked === true,
        modelSelectionTarget: state.sessionsResult?.defaults.modelSelectionTarget,
        modelPickerOpen: state.chatModelPickerOpenSessionKey === state.sessionKey,
        modelSwitching: Boolean(state.chatModelSwitchPromises[state.sessionKey]),
        modelMutationDisabledReason:
          snapshotReason ?? (modelAccess.allowed ? undefined : modelAccess.reason),
        effortMutationDisabledReason:
          snapshotReason ?? (effortAccess.allowed ? undefined : effortAccess.reason),
        contextWindowMutationDisabledReason: contextWindowAccess.allowed
          ? undefined
          : contextWindowAccess.reason,
        sending:
          state.chatSending &&
          state.chatSendingScopeKey ===
            storedChatOutboxScopeKey({
              sessionKey,
              ...(agentScope.agentId ? { agentId: agentScope.agentId } : {}),
            }),
        sessionKey: state.sessionKey,
        selectedSession,
        sessionsResult: state.sessionsResult,
        get stream() {
          return state.chatStream;
        },
        onModelSetup,
        onProviderSettings,
        onAccessProgramSelect: async (next, targetSessionKey, previous) => {
          if (!canPatch({ cyberAccessProgram: next }, targetSessionKey)) {
            return false;
          }
          const confirmed = await switchChatSetting(
            state,
            { kind: "cyberAccessProgram", value: next },
            targetSessionKey,
          );
          if (confirmed && ownsRoute()) {
            await state.accessPreferences?.persistPreference(
              preferenceAgentId ?? "main",
              undefined,
              {
                cyberAccessProgram: next,
                ...(next !== "standard"
                  ? { daybreakAccessProgram: next }
                  : previous
                    ? { daybreakAccessProgram: previous }
                    : {}),
              },
            );
          }
          return confirmed;
        },
        onFastModeSelect: (next, targetSessionKey) =>
          effortAccess.allowed && canPatch({ fastMode: null }, targetSessionKey)
            ? switchChatSetting(state, { kind: "fastMode", value: next }, targetSessionKey)
            : Promise.resolve(false),
        onContextWindowSelect: (next, targetSessionKey) =>
          contextWindowAccess.allowed && canPatch({ contextWindow: next }, targetSessionKey)
            ? switchChatSetting(state, { kind: "contextWindow", value: next }, targetSessionKey)
            : Promise.resolve(false),
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
        onModelPickerTargetSelect: (groupId, value) => {
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
          // Fork: the bound agent may have advertised other models since the last read.
          if (handoff.info?.binding && canUseChatAcpModels(state)) {
            void refreshChatAcpModels(state, sessionKey);
          }
          return refreshChatModelCatalogOnDemand(state);
        },
        onModelPickerOpenChange: (open) => {
          state.chatModelPickerOpenSessionKey = open ? state.sessionKey : null;
          if (!open) {
            // Fork: a choice in the closing picker takes the pending re-send first.
            setTimeout(() => setPendingResend(state, sessionKey, undefined), 0);
          }
          // The native picker already presents this transition.
        },
        onModelSelect: (next, targetSessionKey, agentRuntime) => {
          if (!modelAccess.allowed || !canPatch({ model: next, agentRuntime }, targetSessionKey)) {
            return Promise.resolve(false);
          }
          const resend = takePendingResend(state, sessionKey);
          // Fork: bound to an agent, or re-sending a failed turn: unbind first, then switch and send.
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
          return switchChatModel(
            state,
            next,
            targetSessionKey,
            agentRuntime,
            agentDefaultModel,
          ).then((switched) => {
            if (switched && next) {
              void recordChatPickerSwitch(state, sessionKey, previous, next);
            }
            return switched;
          });
        },
        onThinkingSelect: (next, targetSessionKey) =>
          effortAccess.allowed && canPatch({ thinkingLevel: next }, targetSessionKey)
            ? switchChatSetting(state, { kind: "thinkingLevel", value: next }, targetSessionKey)
            : Promise.resolve(false),
      },
    },
    claudeModePicker: buildChatClaudeModePicker({
      state,
      selectedSession,
      sessionKey,
      agentId: agentScope.agentId,
      expectedSessionId,
      access: permissionAccess,
      canSelectBypass: canSelectFull,
      canPatch: (patch) => canPatch(patch),
      ownsSelection,
    }),
    // Fork: the workbench plan mode toggle, for any model (aiwb-plan.status / aiwb-plan.set).
    planModeToggle: buildChatPlanModeToggle(state, sessionKey, agentScope.agentId),
    permissionPicker: {
      canSelectFull,
      defaultMode: permissionSnapshot
        ? permissionSnapshot.defaultPermissionMode
        : agentDefaultPermissionMode,
      disabled: Boolean(permissionSnapshot) || !permissionAccess.allowed,
      disabledReason: permissionSnapshot
        ? snapshotReason
        : permissionAccess.allowed
          ? undefined
          : permissionAccess.reason,
      mode: currentChange
        ? currentChange.nextMode
        : permissionSnapshot
          ? permissionSnapshot.permissionMode
          : selectedSession?.permissionMode,
      pending: permissionPending,
      onSelect: async (permissionMode) => {
        const activeChange = selection.pending;
        if (
          !permissionAccess.allowed ||
          !canPatch({ permissionMode }) ||
          selectedSession?.permissionModePending ||
          (activeChange && !activeChange.retainWhileCurrent && activeChange.ownsSelection())
        ) {
          return;
        }
        // Keep the selected mode visible while the exact runtime update settles.
        // The pending owner rejects duplicates; the shared settings tail serializes later work.
        let change: PendingPermissionChange = {
          expectedSessionId,
          nextMode: permissionMode ?? undefined,
          ownsSelection,
        };
        const outcomeOwner = Symbol(permissionScopeKey);
        selection.outcome = outcomeOwner;
        const ownsOutcome = () => selection.outcome === outcomeOwner;
        selection.pending = change;
        try {
          state.chatError = state.lastError = null;
          const patched = await patchChatSessionSettings(
            state,
            sessionKey,
            { permissionMode },
            { ...agentScope, expectedSessionId, canDispatch: () => canPatch({ permissionMode }) },
          );
          if (!ownsSelection()) {
            return;
          }
          if (!patched) {
            throw new Error("Session capability is unavailable");
          }
          if (patched.listRefreshError && ownsOutcome()) {
            state.chatError = state.lastError = t("chat.permissionControls.refreshFailed", {
              error: patched.listRefreshError,
            });
          }
        } catch (error) {
          if (!ownsRoute() || !ownsOutcome()) {
            return;
          }
          const retainWhileCurrent = state.sessions.capturePermissionObservation(
            sessionKey,
            affectedAgentId,
          );
          const outcome = await state.sessions.reconcileMutation(affectedAgentId);
          if (!ownsSelection() || !ownsOutcome()) {
            return;
          }
          if (outcome.status !== "refreshed") {
            change = { ...change, retainWhileCurrent };
            selection.pending = change;
          }
          state.chatError = state.lastError = t("chat.permissionControls.updateFailed", {
            error: String(error),
          });
        } finally {
          if (ownsOutcome()) {
            selection.outcome = undefined;
          }
          if (selection.pending === change && change.retainWhileCurrent === undefined) {
            selection.pending = undefined;
          }
        }
      },
    },
  };
}

export function createChatPaneSessionActionCallbacks(params: {
  getSnapshot: () => ApplicationGatewaySnapshot;
  state: ChatPageHost;
  sessionParticipationBlocked: boolean;
  onDenied: (reason: string) => void;
  onAbort: () => void;
  onRewind: (entryId: string, choice?: ChatRewindChoice) => Promise<boolean>;
  onFork: (entryId: string) => Promise<void>;
}): SessionActionCallbacks {
  const { state } = params;
  const client = state.client;
  const recoveryScope = params.getSnapshot().hello?.auth?.recoveryScope ?? client?.recoveryScope;
  const sessionKey = state.sessionKey;
  const selectedSession = selectedChatSessionRow(state);
  const sessionId = selectedSession?.sessionId;
  const agentId = scopedAgentParamsForSession(state, sessionKey).agentId;
  const runId = state.chatRunId ?? null;
  const activeRunIds = runId ? undefined : selectedSession?.activeRunIds?.slice();
  const sessionAbortable = state.chatRunSessionAbortable === true;
  const ownsActionTarget = () => {
    const currentSession = selectedChatSessionRow(state);
    const snapshot = params.getSnapshot();
    const currentRecoveryScope =
      snapshot.hello?.auth?.recoveryScope ??
      (snapshot.phase !== "connected" || client?.recoveryScopeReady
        ? client?.recoveryScope
        : undefined);
    return (
      state.client === client &&
      snapshot.client === client &&
      recoveryScope === currentRecoveryScope &&
      state.sessionKey === sessionKey &&
      scopedAgentParamsForSession(state, sessionKey).agentId === agentId &&
      (state.chatRunId ?? null) === runId &&
      (state.chatRunSessionAbortable === true) === sessionAbortable &&
      (!sessionId || !currentSession?.sessionId || currentSession.sessionId === sessionId) &&
      (!activeRunIds ||
        (currentSession?.activeRunIds?.length === activeRunIds.length &&
          activeRunIds.every((id) => currentSession?.activeRunIds?.includes(id))))
    );
  };
  const readAccess = () => {
    const snapshot = params.getSnapshot();
    const hasLocalRun = Boolean(state.chatRunId);
    const access = readChatSessionActionAccess(snapshot, hasLocalRun, {
      session: selectedChatSessionRow(state),
      sessionAbortable: state.chatRunSessionAbortable === true,
    });
    // Offline Stop captures intent only. The pane retires runs on client
    // replacement; replay checks the original client and current write access.
    if (
      snapshot.client &&
      hasLocalRun &&
      recoveryScope &&
      !access.abort.allowed &&
      access.abort.cause === "disconnected"
    ) {
      access.abort = { allowed: true, requiredScope: "operator.write" };
    }
    return access;
  };
  const access = readAccess();
  const requireCurrent = (action: SessionAction): boolean => {
    const current = readAccess()[action];
    if (current.allowed) {
      return true;
    }
    params.onDenied(current.reason);
    return false;
  };
  return {
    onAbort:
      params.sessionParticipationBlocked || !access.abort.allowed
        ? undefined
        : () => {
            if (ownsActionTarget() && requireCurrent("abort")) {
              params.onAbort();
            }
          },
    onCompact:
      !params.sessionParticipationBlocked &&
      !parseCatalogSessionKey(sessionKey) &&
      access.compact.allowed
        ? async () => {
            if (ownsActionTarget() && requireCurrent("compact")) {
              await state.handleSendChat("/compact");
            }
          }
        : undefined,
    onRewindMessage: access.rewind.allowed
      ? (entryId, choice) => (requireCurrent("rewind") ? params.onRewind(entryId, choice) : false)
      : undefined,
    onForkMessage: access.fork.allowed
      ? (entryId) => (requireCurrent("fork") ? params.onFork(entryId) : undefined)
      : undefined,
  };
}
