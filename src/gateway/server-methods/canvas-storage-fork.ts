// Fork: canvas.storage.* methods back openclaw.storage / window.storage of inline chat widgets.
// Kept out of canvas.ts so upstream changes there merge without conflicts.
import {
  ErrorCodes,
  errorShape,
  validateCanvasStorageDeleteParams,
  validateCanvasStorageGetParams,
  validateCanvasStorageListParams,
  validateCanvasStorageSetParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { isCoreCanvasHostEnabled } from "../../canvas/config.js";
import {
  deleteWidgetStorageValue,
  getWidgetStorageValue,
  listWidgetStorageKeys,
  setWidgetStorageValue,
  WidgetStorageError,
  type WidgetStorageTarget,
} from "../../canvas/widget-storage.js";
import { SessionMutationAuthorizationChangedError } from "../session-mutation-authorization-error.js";
import { sessionObserverScopeKey } from "../session-observer-model.js";
import { resolveRequestedSessionStoreTarget } from "../session-store-key.js";
import { retainSessionScopedRead } from "./session-scoped-read.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";
import { defineValidatedGatewayMethod } from "./validation.js";

const CANVAS_WIDGET_UNAVAILABLE =
  "Canvas widget unavailable; reload the chat or ask the agent to recreate it.";

/**
 * Widget storage is scoped by the session the caller is authorized for and the
 * document it renders. The widget never names either: the Control UI binds both
 * from the transcript row that hosts the frame.
 */
async function runWidgetStorageRequest<T>(
  invocation: GatewayRequestHandlerOptions & {
    params: { sessionKey: string; agentId?: string; docId: string };
  },
  operation: (target: WidgetStorageTarget, assertCurrent: () => void) => Promise<T>,
): Promise<void> {
  const { params, context, respond, sessionMutationAuthorization } = invocation;
  const cfg = context.getRuntimeConfig();
  if (!isCoreCanvasHostEnabled(cfg)) {
    respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, CANVAS_WIDGET_UNAVAILABLE));
    return;
  }
  const requested = resolveRequestedSessionStoreTarget(cfg, params.sessionKey, params.agentId);
  if (!requested.ok) {
    respond(false, undefined, requested.error);
    return;
  }
  const { sessionKey, agentId } = requested.value;
  // Lazy handler preparation can outlive the session authorized by the router.
  sessionMutationAuthorization?.assertCurrent();
  const read = await retainSessionScopedRead(invocation, sessionKey, agentId);
  const assertCurrent = () => {
    invocation.signal?.throwIfAborted();
    sessionMutationAuthorization?.assertCurrent();
    read?.assertCurrent();
  };
  try {
    const result = await operation(
      { docId: params.docId, scopeKey: sessionObserverScopeKey(sessionKey, agentId) },
      assertCurrent,
    );
    assertCurrent();
    respond(true, result);
  } catch (error) {
    if (error instanceof SessionMutationAuthorizationChangedError) {
      throw error;
    }
    const code =
      error instanceof WidgetStorageError && error.code !== "unavailable"
        ? ErrorCodes.INVALID_REQUEST
        : ErrorCodes.UNAVAILABLE;
    respond(
      false,
      undefined,
      errorShape(
        code,
        error instanceof WidgetStorageError ? error.message : "widget storage is unavailable",
      ),
    );
  } finally {
    read?.release();
  }
}

export const canvasStorageHandlers: GatewayRequestHandlers = {
  "canvas.storage.get": defineValidatedGatewayMethod(
    "canvas.storage.get",
    validateCanvasStorageGetParams,
    (invocation) =>
      runWidgetStorageRequest(invocation, async (target) => ({
        value: await getWidgetStorageValue(target, invocation.params.key),
      })),
  ),
  "canvas.storage.list": defineValidatedGatewayMethod(
    "canvas.storage.list",
    validateCanvasStorageListParams,
    (invocation) =>
      runWidgetStorageRequest(invocation, async (target) => ({
        keys: await listWidgetStorageKeys(target, invocation.params.prefix),
      })),
  ),
  "canvas.storage.set": defineValidatedGatewayMethod(
    "canvas.storage.set",
    validateCanvasStorageSetParams,
    (invocation) =>
      runWidgetStorageRequest(invocation, async (target, assertCurrent) => {
        assertCurrent();
        invocation.sessionMutationCommitGuard?.();
        await setWidgetStorageValue(target, invocation.params.key, invocation.params.value);
        return { ok: true };
      }),
  ),
  "canvas.storage.delete": defineValidatedGatewayMethod(
    "canvas.storage.delete",
    validateCanvasStorageDeleteParams,
    (invocation) =>
      runWidgetStorageRequest(invocation, async (target, assertCurrent) => {
        assertCurrent();
        invocation.sessionMutationCommitGuard?.();
        return { deleted: await deleteWidgetStorageValue(target, invocation.params.key) };
      }),
  ),
};
