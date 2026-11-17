/**
 * Fork: Gateway maintenance mode. While it is on, no new chat turn starts: chat requests are
 * refused with a maintenance error, durable channel ingress keeps messages queued, cron
 * scheduling and heartbeats wait. Admin work (config, plugins, skills) stays open, so an
 * installer can replace OpenClaw and rewrite its setup without a turn starting in between.
 *
 * The state lives in `<stateDir>/gateway-maintenance.json` and survives a Gateway restart.
 * An optional `untilMs` ends it on its own, so a killed installer cannot pause chats forever.
 */
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/state-dir.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { notifyListeners, registerListener } from "../shared/listeners.js";

export type GatewayMaintenanceState = {
  /** Epoch ms when maintenance began. */
  since: number;
  /** Who turned it on: `installer`, `control-ui`, `cli`, … */
  source: string;
  /** Free text shown to people whose messages wait. */
  reason: string;
  /** Epoch ms when maintenance ends on its own; null keeps it until it is turned off. */
  untilMs: number | null;
};

export const GATEWAY_MAINTENANCE_FILE = "gateway-maintenance.json";
export const GATEWAY_MAINTENANCE_UNAVAILABLE_REASON = "gateway-maintenance";
const MAX_TEXT = 200;

type MaintenanceListener = (state: GatewayMaintenanceState | null) => void;

type MaintenanceStore = {
  loaded: boolean;
  filePath: string | null;
  current: GatewayMaintenanceState | null;
  timer: ReturnType<typeof setTimeout> | undefined;
  listeners: Set<MaintenanceListener>;
};

const STORE = resolveGlobalSingleton(
  Symbol.for("openclaw.fork.gatewayMaintenanceMode"),
  (): MaintenanceStore => ({
    loaded: false,
    filePath: null,
    current: null,
    timer: undefined,
    listeners: new Set(),
  }),
);

function cleanText(value: unknown, fallback: string): string {
  if (typeof value !== "string") {
    return fallback;
  }
  const text = value
    .replace(/[\p{Cc}\s]+/gu, " ")
    .trim()
    .slice(0, MAX_TEXT);
  return text || fallback;
}

/** Validates a stored or requested state; anything malformed reads as "off". */
export function normalizeGatewayMaintenanceState(value: unknown): GatewayMaintenanceState | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const since = record.since;
  if (typeof since !== "number" || !Number.isFinite(since) || since <= 0) {
    return null;
  }
  const until = record.untilMs;
  return {
    since: Math.floor(since),
    source: cleanText(record.source, "unknown"),
    reason: cleanText(record.reason, "maintenance"),
    untilMs: typeof until === "number" && Number.isFinite(until) && until > 0 ? until : null,
  };
}

function resolveFilePath(): string {
  return (STORE.filePath ??= path.join(resolveStateDir(), GATEWAY_MAINTENANCE_FILE));
}

function readFileState(): GatewayMaintenanceState | null {
  try {
    return normalizeGatewayMaintenanceState(JSON.parse(fs.readFileSync(resolveFilePath(), "utf8")));
  } catch {
    return null;
  }
}

function writeFileState(state: GatewayMaintenanceState | null): void {
  const file = resolveFilePath();
  if (!state) {
    fs.rmSync(file, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function armExpiry(): void {
  if (STORE.timer) {
    clearTimeout(STORE.timer);
    STORE.timer = undefined;
  }
  const until = STORE.current?.untilMs;
  if (typeof until !== "number") {
    return;
  }
  // setTimeout caps at ~24.8 days; re-arm in steps for longer windows.
  const delay = Math.min(Math.max(0, until - Date.now()), 2 ** 31 - 1);
  STORE.timer = setTimeout(() => {
    STORE.timer = undefined;
    getGatewayMaintenance();
    armExpiry();
  }, delay);
  STORE.timer.unref?.();
}

function publish(next: GatewayMaintenanceState | null): void {
  STORE.current = next;
  armExpiry();
  notifyListeners(STORE.listeners, next);
}

function ensureLoaded(): void {
  if (STORE.loaded) {
    return;
  }
  STORE.loaded = true;
  STORE.current = readFileState();
  armExpiry();
}

/** The current maintenance state, or null when chats run normally. Expired state is cleared. */
export function getGatewayMaintenance(now: number = Date.now()): GatewayMaintenanceState | null {
  ensureLoaded();
  const current = STORE.current;
  if (current && current.untilMs !== null && current.untilMs <= now) {
    try {
      writeFileState(null);
    } catch {
      // The in-memory state still ends; the stale file reads as expired next time.
    }
    publish(null);
    return null;
  }
  return current;
}

export function isGatewayMaintenanceActive(): boolean {
  return getGatewayMaintenance() !== null;
}

/** Turns maintenance on (or updates it). Persists before publishing so a restart keeps it. */
export function enterGatewayMaintenance(params: {
  source?: string;
  reason?: string;
  ttlMs?: number | null;
  now?: number;
}): GatewayMaintenanceState {
  ensureLoaded();
  const now = params.now ?? Date.now();
  const ttl = params.ttlMs;
  const next: GatewayMaintenanceState = {
    since: STORE.current?.since ?? now,
    source: cleanText(params.source, "unknown"),
    reason: cleanText(params.reason, "maintenance"),
    untilMs: typeof ttl === "number" && Number.isFinite(ttl) && ttl > 0 ? now + ttl : null,
  };
  writeFileState(next);
  publish(next);
  return next;
}

/** Turns maintenance off. Returns whether it was on. */
export function exitGatewayMaintenance(): boolean {
  const wasActive = getGatewayMaintenance() !== null;
  writeFileState(null);
  if (wasActive) {
    publish(null);
  }
  return wasActive;
}

export function onGatewayMaintenanceChange(listener: MaintenanceListener): () => void {
  return registerListener(STORE.listeners, listener);
}

/** The text a refused chat message gets. */
export function formatGatewayMaintenanceMessage(state: GatewayMaintenanceState | null): string {
  const reason = state && state.reason !== "maintenance" ? ` (${state.reason})` : "";
  return `OpenClaw is under maintenance${reason}: chats are paused. Your message was not sent; send it again when maintenance ends.`;
}

export function resetGatewayMaintenanceForTest(filePath?: string): void {
  if (STORE.timer) {
    clearTimeout(STORE.timer);
  }
  STORE.loaded = false;
  STORE.filePath = filePath ?? null;
  STORE.current = null;
  STORE.timer = undefined;
  STORE.listeners.clear();
}
