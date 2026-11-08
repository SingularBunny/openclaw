import {
  CANVAS_DOCUMENT_PREVIEW_MAX_BYTES,
  WIDGET_HTML_MAX_UTF8_BYTES,
  type CanvasDocumentViewResult,
  ErrorCodes,
  errorShape,
  validateCanvasDocumentPreviewParams,
  validateCanvasDocumentViewParams,
  validateCanvasStorageDeleteParams,
  validateCanvasStorageGetParams,
  validateCanvasStorageListParams,
  validateCanvasStorageSetParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { buildSandboxHostPath } from "../../agents/sandbox-host.js";
import { isCoreCanvasHostEnabled } from "../../canvas/config.js";
import { readCanvasDocumentHtmlSource } from "../../canvas/documents.js";
import {
  deleteWidgetStorageValue,
  getWidgetStorageValue,
  listWidgetStorageKeys,
  setWidgetStorageValue,
  WidgetStorageError,
  type WidgetStorageTarget,
} from "../../canvas/widget-storage.js";
import { isGatewaySubordinateWorkAdmissionClosed } from "../../process/gateway-work-admission.js";
import { buildBoardWidgetSandboxPath } from "../board-sandbox.js";
import { SessionMutationAuthorizationChangedError } from "../session-mutation-authorization-error.js";
import { sessionObserverScopeKey } from "../session-observer-model.js";
import { resolveRequestedSessionStoreTarget } from "../session-store-key.js";
import { retainSessionScopedRead } from "./session-scoped-read.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";
import { defineValidatedGatewayMethod } from "./validation.js";

const CANVAS_WIDGET_UNAVAILABLE =
  "Canvas widget unavailable; reload the chat or ask the agent to recreate it.";
const CANVAS_PREVIEW_UNAVAILABLE =
  "Canvas preview unavailable; reload the file preview and try again.";

/** Both stored widgets and caller-owned previews use the same live isolated host. */
async function respondWithCanvasHtml(
  invocation: GatewayRequestHandlerOptions,
  readHtml: () => string | Promise<string>,
  unavailableMessage: string,
  sandboxUrl: string,
): Promise<void> {
  const { context, client, respond } = invocation;
  const resolveContext = context.resolveGatewayContext;
  const methodRegistry = context.getGatewayMethodRegistry?.();
  const assertActive = () => {
    invocation.signal?.throwIfAborted();
    invocation.sessionMutationCommitGuard?.();
    if (
      !resolveContext ||
      resolveContext() !== context ||
      context.resolveGatewayContext !== resolveContext ||
      context.getGatewayMethodRegistry?.() !== methodRegistry ||
      client?.invalidated === true ||
      (client?.connId && context.isConnectionActive?.(client.connId) === false) ||
      isGatewaySubordinateWorkAdmissionClosed() ||
      !isCoreCanvasHostEnabled(context.getRuntimeConfig())
    ) {
      throw new Error(unavailableMessage);
    }
  };
  try {
    assertActive();
    const [html, sandboxPort] = await Promise.all([
      readHtml(),
      context.getMcpAppSandboxPort?.() ?? context.ensureSandboxHostPort?.(),
    ]);
    // The bytes and listener must still belong to the admitted caller and Gateway.
    assertActive();
    if (sandboxPort === undefined) {
      throw new Error(unavailableMessage);
    }
    const ingress = client?.remoteControlUiIngress;
    const configuredOrigin =
      ingress?.sandboxOrigin ?? context.getRuntimeConfig().mcp?.apps?.sandboxOrigin;
    const result: CanvasDocumentViewResult = {
      html,
      sandboxUrl: ingress ? new URL(sandboxUrl, ingress.sandboxOrigin).href : sandboxUrl,
      sandboxPort,
      ...(configuredOrigin ? { sandboxOrigin: new URL(configuredOrigin).origin } : {}),
    };
    respond(true, result);
  } catch {
    respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, unavailableMessage));
  }
}

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

export const canvasHandlers: GatewayRequestHandlers = {
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
  "canvas.document.view": defineValidatedGatewayMethod(
    "canvas.document.view",
    validateCanvasDocumentViewParams,
    (invocation) =>
      respondWithCanvasHtml(
        invocation,
        async () => {
          const document = await readCanvasDocumentHtmlSource(invocation.params.docId, {
            maxBytes: WIDGET_HTML_MAX_UTF8_BYTES,
          });
          if (
            document.cspSandbox !== "scripts" ||
            Buffer.byteLength(document.html, "utf8") > WIDGET_HTML_MAX_UTF8_BYTES
          ) {
            throw new Error(CANVAS_WIDGET_UNAVAILABLE);
          }
          return document.html;
        },
        CANVAS_WIDGET_UNAVAILABLE,
        buildBoardWidgetSandboxPath({ grantState: "none" }),
      ),
  ),
  "canvas.document.preview": defineValidatedGatewayMethod(
    "canvas.document.preview",
    validateCanvasDocumentPreviewParams,
    async (invocation) => {
      const { html } = invocation.params;
      // JSON Schema limits characters; the file-preview contract limits UTF-8 bytes.
      if (Buffer.byteLength(html, "utf8") > CANVAS_DOCUMENT_PREVIEW_MAX_BYTES) {
        invocation.respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "invalid canvas.document.preview params: html must not exceed 2 MiB of UTF-8 data",
          ),
        );
        return;
      }
      await respondWithCanvasHtml(
        invocation,
        () => html,
        CANVAS_PREVIEW_UNAVAILABLE,
        buildSandboxHostPath({ blockDescendantFrames: true }),
      );
    },
  ),
};
