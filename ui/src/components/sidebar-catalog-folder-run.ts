import type { SessionsFilesRevealResult } from "../../../packages/gateway-protocol/src/index.ts";
import type { NavigationRouteId } from "../app-navigation.ts";
import { pathForAgentPanel } from "../app-route-paths.ts";
import type { ApplicationNavigationOptions } from "../app/context.ts";
import { copyToClipboard } from "../lib/clipboard.ts";
import { canCallGatewayMethod } from "../lib/gateway-methods.ts";
import { t } from "../lib/reactive/i18n.ts";
import { showToast } from "../lib/toast.ts";
import type { NewSessionTarget } from "../pages/new-session/location.ts";
import {
  catalogFolderRevealPath,
  type CatalogFolderMenuContext,
  type CatalogFolderNewChat,
  type FolderAppContext,
} from "./sidebar-catalog-folder-actions.ts";

const REVEAL_METHOD = "sessions.files.reveal";

export function openCatalogFolderNewChat(
  newChat: CatalogFolderNewChat | null,
  open: (agentId: string, target?: NewSessionTarget) => void,
): boolean {
  if (!newChat) {
    return false;
  }
  if (newChat.target) {
    open(newChat.agentId, newChat.target);
  } else {
    open(newChat.agentId);
  }
  return true;
}

export function openCatalogFolderAgentSettings(
  agentId: string | null,
  basePath: string,
  navigate:
    | ((routeId: NavigationRouteId, options?: ApplicationNavigationOptions) => void)
    | undefined,
): void {
  if (agentId) {
    navigate?.("agents", { pathname: pathForAgentPanel(agentId, null, basePath) });
  }
}

export function copyCatalogFolderPath(path: string | null): void {
  if (!path) {
    return;
  }
  void copyToClipboard(path).then((copied) =>
    showToast({ message: copied ? t("chat.sidebar.folderPathCopied") : t("common.copyFailed") }),
  );
}

/** A chat of the folder whose workspace the Gateway may open, when the client is an admin. */
export function catalogFolderRevealSource(
  app: FolderAppContext,
  context: CatalogFolderMenuContext,
  agentId: string | null,
): { sessionKey: string; agentId: string } | null {
  if (
    !context.path ||
    !canCallGatewayMethod(app?.gateway.snapshot, REVEAL_METHOD, "operator.admin")
  ) {
    return null;
  }
  const owner =
    agentId && context.sessionKeysByAgent[agentId] ? agentId : context.sessionAgentIds[0];
  const sessionKey = owner ? context.sessionKeysByAgent[owner] : undefined;
  return owner && sessionKey ? { sessionKey, agentId: owner } : null;
}

/** The folder relative to that chat's workspace, or null when the Gateway cannot open it. */
export async function checkCatalogFolderReveal(
  app: FolderAppContext,
  source: { sessionKey: string; agentId: string },
  folder: string,
): Promise<string | null> {
  try {
    const listed = await app?.sessions.listFiles(source.sessionKey, {
      agentId: source.agentId,
      path: "",
    });
    return catalogFolderRevealPath(listed?.roots?.[0] ?? listed?.root, folder);
  } catch {
    return null;
  }
}

export async function revealCatalogFolder(
  app: FolderAppContext,
  source: { sessionKey: string; agentId: string },
  relativePath: string,
): Promise<void> {
  const client = app?.gateway.snapshot.client;
  if (!client) {
    return;
  }
  try {
    const result = await client.request<SessionsFilesRevealResult>(REVEAL_METHOD, {
      key: source.sessionKey,
      agentId: source.agentId,
      ...(relativePath ? { path: relativePath } : {}),
    });
    if (!result.ok) {
      showToast({ message: result.error ?? t("chat.sidebar.folderRevealFailed") });
    }
  } catch (error) {
    showToast({ message: `${t("chat.sidebar.folderRevealFailed")} ${String(error)}` });
  }
}
