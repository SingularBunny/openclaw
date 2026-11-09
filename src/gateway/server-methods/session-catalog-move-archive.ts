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
