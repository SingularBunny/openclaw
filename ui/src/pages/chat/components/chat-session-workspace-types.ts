import type { GatewayBrowserClient, GatewayHelloOk } from "../../../api/gateway.ts";
import type { SessionWorkspaceListResult } from "../../../api/types.ts";
import type { UiSettings } from "../../../app/settings.ts";
import type { SessionCapability, SessionScopeHost } from "../../../lib/sessions/index.ts";
import type {
  FileSidebarNavigation,
  SidebarContent,
  SidebarSelection,
} from "./chat-sidebar-content-types.ts";

export type SessionWorkspaceFilter = "all" | "changed" | "read" | "artifacts";

export type SessionWorkspaceProps = {
  filter: SessionWorkspaceFilter;
  browserPath: string;
  browserSearch: string;
  sessionKey: string;
  list: SessionWorkspaceListResult | null;
  /** Fork (F34): folders the panel can browse (workspace first) and the one shown; null = workspace. */
  roots?: readonly string[] | null;
  browseRoot?: string | null;
  onSelectRoot?: (root: string | null) => void;
  loading: boolean;
  error: string | null;
  activeId: string | null;
  onBrowsePath: (path: string) => void;
  onOpenFile: (path: string, origin: "session" | "workspace") => void;
  onSearch: (search: string) => void;
  onSetFilter: (filter: SessionWorkspaceFilter) => void;
  onOpenArtifact: (artifactId: string) => void;
  /** Opens the session diff panel; absent until a usable checkout is known. */
  onOpenDiff?: () => void;
};

export type SessionWorkspacePreview = {
  id: string;
  label: string;
  content: SidebarSelection;
  canonicalKey?: string;
  requestIds?: string[];
  navigation?: FileSidebarNavigation;
  navigationOrder?: number;
};

export type SessionWorkspaceState = {
  navigationOrder?: number;
  previews: SessionWorkspacePreview[];
  activePreviewId: string | null;
  filter: SessionWorkspaceFilter;
  activeId: string | null;
  agentId: string;
  browserPath: string;
  browserSearch: string;
  /** Fork (F34): another folder of the session shown instead of the workspace (null: workspace). */
  browseRoot: string | null;
  /** Fork (F34): folders sessions.files.list offers, workspace first; null until the first listing. */
  roots: readonly string[] | null;
  browserSearchTimer: ReturnType<typeof globalThis.setTimeout> | null;
  connectionEpoch: number;
  diffContent?: SidebarContent;
  error: string | null;
  errorOwner?: object;
  list: SessionWorkspaceListResult | null;
  loading: boolean;
  pendingReload: boolean;
  sessionKey: string;
};

// Re-renders must preserve the document identity or the mounted diff panel
// treats its loader as new and requests sessions.diff again.
export type SessionWorkspaceHost = {
  sessionKey: string;
  sessions: SessionCapability;
  client: GatewayBrowserClient | null;
  connected: boolean;
  connectionEpoch: number;
  hello: GatewayHelloOk | null;
  resourceBasePath?: string;
  terminalAvailable?: boolean;
  browserPanelAvailable?: boolean;
  assistantAgentId?: string | null;
  agentsList?: SessionScopeHost["agentsList"];
  settings?: UiSettings;
  sessionWorkspaceState?: SessionWorkspaceState;
  sessionWorkspaceDraftScope?: string;
  sessionWorkspaceDraftContext?: { sessionTitle?: string; paneLabel?: string };
  sidebarContent: SidebarSelection | null;
  requestUpdate?: () => void;
  handleOpenSidebar: (content: SidebarSelection | null) => void;
};
