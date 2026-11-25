/**
 * Fork: per ACP session "allow all" for permission requests ("Allow all in this chat" in the
 * permission question, the composer's Permissions toggle). Session-scoped: the plugin-wide
 * `permissionMode` never changes. Persisted in the plugin state store under the ACP session key,
 * so it survives a Gateway restart with the session; closing the session clears it, and a new
 * spawn gets a new key and starts in "ask". Decisions (plan review, step limit) and ACP forms are
 * still asked: only allow/deny permission requests are covered.
 */

export type AcpxChatPermissionMode = "ask" | "allow-all";

export type AcpxPermissionModeRecord = { mode: "allow-all"; at: number };

export type AcpxPermissionModeStore = {
  lookup(key: string): Promise<AcpxPermissionModeRecord | undefined>;
  register(key: string, value: AcpxPermissionModeRecord): Promise<void>;
  delete(key: string): Promise<boolean>;
};

const MAX_CACHED_SESSIONS = 2_048;

export function readAcpxChatPermissionMode(value: unknown): AcpxChatPermissionMode | undefined {
  return value === "ask" || value === "allow-all" ? value : undefined;
}

export class AcpxSessionPermissionModes {
  private readonly cache = new Map<string, boolean>();
  private readonly listeners = new Map<string, Set<() => void>>();
  private openStore: (() => AcpxPermissionModeStore) | undefined;
  private store: AcpxPermissionModeStore | undefined;

  /** The store opens on first use; registering the plugin must not touch runtime state. */
  bindStore(open: () => AcpxPermissionModeStore): void {
    this.openStore = open;
    this.store = undefined;
    this.cache.clear();
  }

  private currentStore(): AcpxPermissionModeStore | undefined {
    if (!this.store && this.openStore) {
      this.store = this.openStore();
    }
    return this.store;
  }

  private remember(sessionKey: string, allowAll: boolean): void {
    this.cache.delete(sessionKey);
    if (this.cache.size >= MAX_CACHED_SESSIONS) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) {
        this.cache.delete(oldest);
      }
    }
    this.cache.set(sessionKey, allowAll);
  }

  async get(sessionKey: string): Promise<AcpxChatPermissionMode> {
    const cached = this.cache.get(sessionKey);
    if (cached !== undefined) {
      return cached ? "allow-all" : "ask";
    }
    const record = await this.currentStore()?.lookup(sessionKey);
    const allowAll = record?.mode === "allow-all";
    // A set() that ran while this read waited wins over the stored value it replaced.
    if (!this.cache.has(sessionKey)) {
      this.remember(sessionKey, allowAll);
    }
    return this.cache.get(sessionKey) ? "allow-all" : "ask";
  }

  async isAllowAll(sessionKey: string): Promise<boolean> {
    return (await this.get(sessionKey)) === "allow-all";
  }

  /** Switching to allow-all also answers the session's open and queued permission questions. */
  async set(sessionKey: string, mode: AcpxChatPermissionMode): Promise<void> {
    this.remember(sessionKey, mode === "allow-all");
    if (mode === "allow-all") {
      // A copy: a listener may unsubscribe while the set is walked.
      for (const listener of Array.from(this.listeners.get(sessionKey) ?? [])) {
        listener();
      }
    }
    const store = this.currentStore();
    if (mode === "allow-all") {
      await store?.register(sessionKey, { mode, at: Date.now() });
    } else {
      await store?.delete(sessionKey);
    }
  }

  /** The ACP session closed: its key is never reused, so the mode goes with it. */
  async clear(sessionKey: string): Promise<void> {
    this.remember(sessionKey, false);
    await this.currentStore()?.delete(sessionKey);
  }

  /** Called when the session switches to allow-all; returns the unsubscribe. */
  onAllowAll(sessionKey: string, listener: () => void): () => void {
    const set = this.listeners.get(sessionKey) ?? new Set<() => void>();
    this.listeners.set(sessionKey, set);
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0 && this.listeners.get(sessionKey) === set) {
        this.listeners.delete(sessionKey);
      }
    };
  }
}

/** One per plugin module: the runtime's permission bridge and the chat methods share it. */
export const acpxPermissionModes = new AcpxSessionPermissionModes();
