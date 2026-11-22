import { formatErrorMessage } from "../../infra/errors.js";
import type { SessionCatalogSessionArchive } from "../../plugins/session-catalog.js";
import { dispatchGatewayRequestInProcess } from "../server-in-process-dispatch.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

type CallerOptions = Pick<
  GatewayRequestHandlerOptions,
  "client" | "context" | "hasCurrentClientAuthority" | "isWebchatConnect"
>;

/**
 * Archives a Gateway session a catalog provider named, as the caller of the catalog request.
 * The provider decides which session a row stands for, but a plugin may patch only sessions
 * it created; the operator acting on the row may archive any session `sessions.patch` lets them.
 */
export async function archiveCatalogSessionAsCaller(
  options: CallerOptions,
  archive: SessionCatalogSessionArchive,
  requestIdPrefix: "catalog-archive" | "catalog-move",
): Promise<void> {
  await dispatchGatewayRequestInProcess(
    "sessions.patch",
    {
      key: archive.key,
      ...(archive.expectedSessionId ? { expectedSessionId: archive.expectedSessionId } : {}),
      archived: true,
    },
    {
      client: options.client,
      context: options.context,
      isWebchatConnect: options.isWebchatConnect,
      methodRegistry: options.context.getGatewayMethodRegistry?.(),
      requestIdPrefix,
      ...(options.hasCurrentClientAuthority
        ? { hasCurrentClientAuthority: options.hasCurrentClientAuthority }
        : {}),
    },
  );
}

/**
 * Archives the session a catalog move left behind. Returns a warning instead of failing:
 * the move itself has already happened.
 */
export async function archiveMovedCatalogSource(
  options: CallerOptions,
  archive: SessionCatalogSessionArchive | undefined,
): Promise<string | undefined> {
  if (!archive) {
    return undefined;
  }
  try {
    await archiveCatalogSessionAsCaller(options, archive, "catalog-move");
    return undefined;
  } catch (error) {
    return `Moved, but the previous session ${archive.key} was not archived: ${formatErrorMessage(error)}. Archive it to avoid seeing the chat twice.`;
  }
}

/**
 * Shares the session a catalog move created, as the caller of the move: the session sharing
 * checks hold the operator's authority, which a plugin dispatching inside the operator's request
 * does not carry. Returns a warning instead of failing: the move itself has already happened.
 */
export async function shareMovedCatalogSession(
  options: CallerOptions,
  share: { key: string } | undefined,
): Promise<string | undefined> {
  if (!share) {
    return undefined;
  }
  try {
    await dispatchGatewayRequestInProcess(
      "session.visibility.set",
      { sessionKey: share.key, visibility: "shared" },
      {
        client: options.client,
        context: options.context,
        isWebchatConnect: options.isWebchatConnect,
        methodRegistry: options.context.getGatewayMethodRegistry?.(),
        requestIdPrefix: "catalog-move",
        ...(options.hasCurrentClientAuthority
          ? { hasCurrentClientAuthority: options.hasCurrentClientAuthority }
          : {}),
      },
    );
    return undefined;
  } catch (error) {
    return `Moved, but the new session ${share.key} is still a draft: ${formatErrorMessage(error)}. Share it, then archive the previous one.`;
  }
}
