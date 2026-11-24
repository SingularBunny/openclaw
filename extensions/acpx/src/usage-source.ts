/**
 * Account usage of configured ACP agents for the provider-usage (Limits) views.
 * An agent opts in with `agents.<id>.usage`; each one becomes its own usage entry
 * (`acp-<id>`), never a model provider. Probes start a process, so results are
 * cached per agent, refreshed in the background one at a time, and served with
 * their age instead of holding the page up.
 */
import type { ProviderUsageSnapshot } from "openclaw/plugin-sdk/provider-usage";
import { resolveAcpxPluginConfig } from "./config.js";
import { AcpUsageProbeError, runAcpUsageProbe, type AcpUsageProbeParams } from "./usage-probe.js";
import { parseAcpUsageReply } from "./usage-reply.js";

export const DEFAULT_USAGE_PROBE_TIMEOUT_MS = 30_000;
export const DEFAULT_USAGE_CACHE_TTL_MS = 10 * 60_000;
/** Failed probes are retried sooner than good values expire. */
const FAILED_USAGE_CACHE_TTL_MS = 60_000;
/** Leave the host this much of its deadline to merge and answer. */
const HOST_DEADLINE_MARGIN_MS = 250;

export type AcpxAgentUsageConfig = {
  command?: string;
  timeoutMs?: number;
  cacheTtlMs?: number;
  label?: string;
};

type ProbeTarget = {
  agentId: string;
  provider: string;
  displayName: string;
  argv: string[];
  command?: string;
  timeoutMs: number;
  cacheTtlMs: number;
  env: NodeJS.ProcessEnv;
  /** Changes when the agent's command or probe settings change. */
  key: string;
};

type UsageValue = Omit<ProviderUsageSnapshot, "observedAt" | "refreshing">;

type CacheEntry = {
  key: string;
  value?: UsageValue;
  observedAt?: number;
  /** Last good value, kept while a later probe fails. */
  lastGood?: { value: UsageValue; observedAt: number };
  inflight?: Promise<void>;
  abort?: AbortController;
};

/** Usage entry id of an ACP agent; prefixed so it cannot shadow a model provider. */
export function acpAgentUsageProviderId(agentId: string): string {
  return `acp-${agentId}`;
}

function defaultDisplayName(agentId: string): string {
  return agentId.length > 0 ? `${agentId[0]?.toUpperCase()}${agentId.slice(1)}` : agentId;
}

// Mirrors acpx's agentProcessEnvAllow/Block contract for the probe's own process.
const ESSENTIAL_ENV_NAMES = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LANGUAGE",
  "TZ",
  "TMPDIR",
  "TMP",
  "TEMP",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
]);

export function resolveUsageProbeEnv(
  env: NodeJS.ProcessEnv,
  policy: { allow?: readonly string[]; block?: readonly string[] },
): NodeJS.ProcessEnv {
  if (policy.allow === undefined && !policy.block?.length) {
    return { ...env };
  }
  const blocked = new Set(policy.block ?? []);
  const allowed = policy.allow ? new Set([...ESSENTIAL_ENV_NAMES, ...policy.allow]) : undefined;
  const result: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    const keep =
      name.startsWith("ACPX_AUTH_") ||
      (!blocked.has(name) &&
        (!allowed || allowed.has(name) || name.startsWith("LC_") || name.startsWith("XDG_")));
    if (keep) {
      result[name] = value;
    }
  }
  return result;
}

function readRawAgentUsage(rawConfig: unknown): Map<string, AcpxAgentUsageConfig> {
  const agents = (rawConfig as { agents?: Record<string, { usage?: AcpxAgentUsageConfig }> })
    ?.agents;
  const result = new Map<string, AcpxAgentUsageConfig>();
  for (const [id, entry] of Object.entries(agents ?? {})) {
    if (entry?.usage && typeof entry.usage === "object") {
      result.set(id.trim().toLowerCase(), entry.usage);
    }
  }
  return result;
}

/** Agents that opted into a usage probe, with everything a probe needs. */
export function resolveUsageProbeTargets(params: {
  rawConfig: unknown;
  env: NodeJS.ProcessEnv;
}): ProbeTarget[] {
  const usageByAgent = readRawAgentUsage(params.rawConfig);
  if (usageByAgent.size === 0) {
    return [];
  }
  const resolved = resolveAcpxPluginConfig({ rawConfig: params.rawConfig });
  const identities =
    (params.rawConfig as { agentIdentities?: Record<string, { name?: string }> })
      ?.agentIdentities ?? {};
  const env = resolveUsageProbeEnv(params.env, {
    allow: resolved.agentProcessEnvAllow,
    block: resolved.agentProcessEnvBlock,
  });
  const targets: ProbeTarget[] = [];
  for (const [agentId, usage] of usageByAgent) {
    const command = resolved.agents[agentId];
    const argv = typeof command === "string" ? [command] : [...(command ?? [])];
    const timeoutMs = usage.timeoutMs ?? DEFAULT_USAGE_PROBE_TIMEOUT_MS;
    const cacheTtlMs = usage.cacheTtlMs ?? DEFAULT_USAGE_CACHE_TTL_MS;
    targets.push({
      agentId,
      provider: acpAgentUsageProviderId(agentId),
      displayName:
        usage.label?.trim() || identities[agentId]?.name?.trim() || defaultDisplayName(agentId),
      argv,
      ...(usage.command ? { command: usage.command } : {}),
      timeoutMs,
      cacheTtlMs,
      env,
      key: JSON.stringify([argv, usage.command ?? null, timeoutMs]),
    });
  }
  return targets.toSorted((a, b) => a.agentId.localeCompare(b.agentId));
}

type ProbeRunner = (params: AcpUsageProbeParams) => Promise<string>;

/** Turns one probe outcome into a usage entry; failures become an error entry. */
export async function probeAgentUsage(
  target: ProbeTarget,
  signal: AbortSignal,
  run: ProbeRunner = runAcpUsageProbe,
): Promise<{ value: UsageValue; ok: boolean }> {
  const base = { provider: target.provider, displayName: target.displayName, windows: [] };
  if (target.argv.length === 0) {
    return {
      value: { ...base, error: `No command configured for ACP agent ${target.agentId}` },
      ok: false,
    };
  }
  try {
    const text = await run({
      argv: target.argv,
      ...(target.command ? { command: target.command } : {}),
      timeoutMs: target.timeoutMs,
      env: target.env,
      signal,
    });
    const reply = parseAcpUsageReply(text);
    if (reply.kind === "logged-out") {
      return { value: { ...base, error: "The agent is not logged in" }, ok: false };
    }
    if (reply.kind === "error") {
      return { value: { ...base, error: reply.message }, ok: false };
    }
    return {
      value: {
        ...base,
        ...(reply.plan ? { plan: reply.plan } : {}),
        ...(reply.balance
          ? {
              billing: [
                {
                  type: "balance" as const,
                  label: reply.balance.label,
                  amount: reply.balance.amount,
                  unit: reply.balance.unit,
                },
              ],
            }
          : {}),
      },
      ok: true,
    };
  } catch (error) {
    const message =
      error instanceof AcpUsageProbeError
        ? error.message
        : error instanceof Error
          ? error.message
          : String(error);
    return { value: { ...base, error: message || "Usage probe failed" }, ok: false };
  }
}

export type AcpAgentUsageSource = {
  collect(ctx: {
    rawConfig: unknown;
    env: NodeJS.ProcessEnv;
    signal: AbortSignal;
    timeoutMs: number;
  }): Promise<ProviderUsageSnapshot[]>;
  /** Drops an agent's cached value so the next read probes again (e.g. after a balance error). */
  invalidate(agentId?: string): void;
  /** Stops running probes; called when the plugin stops. */
  dispose(): void;
};

export function createAcpAgentUsageSource(
  options: { run?: ProbeRunner; now?: () => number } = {},
): AcpAgentUsageSource {
  const run = options.run ?? runAcpUsageProbe;
  const now = options.now ?? Date.now;
  const cache = new Map<string, CacheEntry>();
  let disposed = false;

  const isFresh = (entry: CacheEntry, target: ProbeTarget) => {
    if (entry.observedAt === undefined || entry.value === undefined) {
      return false;
    }
    const ttl = entry.value.error ? FAILED_USAGE_CACHE_TTL_MS : target.cacheTtlMs;
    return now() - entry.observedAt < ttl;
  };

  const refresh = (entry: CacheEntry, target: ProbeTarget) => {
    if (entry.inflight || disposed) {
      return;
    }
    const abort = new AbortController();
    entry.abort = abort;
    entry.inflight = probeAgentUsage(target, abort.signal, run)
      .then(({ value, ok }) => {
        if (cache.get(target.agentId) !== entry || abort.signal.aborted) {
          return;
        }
        const observedAt = now();
        entry.value = value;
        entry.observedAt = observedAt;
        if (ok) {
          entry.lastGood = { value, observedAt };
        }
      })
      .finally(() => {
        entry.inflight = undefined;
        entry.abort = undefined;
      });
  };

  const present = (entry: CacheEntry, target: ProbeTarget): ProviderUsageSnapshot => {
    const refreshing = entry.inflight !== undefined;
    // A failed refresh keeps the last good balance visible, with its age.
    const shown = entry.value?.error && entry.lastGood ? entry.lastGood : undefined;
    const value = shown?.value ?? entry.value;
    const observedAt = shown?.observedAt ?? entry.observedAt;
    if (!value) {
      return {
        provider: target.provider,
        displayName: target.displayName,
        windows: [],
        refreshing: true,
      };
    }
    return {
      ...value,
      displayName: target.displayName,
      ...(observedAt !== undefined && !value.error ? { observedAt } : {}),
      ...(refreshing ? { refreshing: true } : {}),
    };
  };

  return {
    async collect(ctx) {
      if (disposed) {
        return [];
      }
      const targets = resolveUsageProbeTargets({ rawConfig: ctx.rawConfig, env: ctx.env });
      const live = new Set(targets.map((target) => target.agentId));
      for (const [agentId, entry] of cache) {
        if (!live.has(agentId)) {
          entry.abort?.abort();
          cache.delete(agentId);
        }
      }
      for (const target of targets) {
        let entry = cache.get(target.agentId);
        if (!entry || entry.key !== target.key) {
          entry?.abort?.abort();
          entry = { key: target.key };
          cache.set(target.agentId, entry);
        }
        if (!isFresh(entry, target)) {
          refresh(entry, target);
        }
      }
      // A cold cache waits for its probe only while the host still waits.
      const cold = targets
        .map((target) => cache.get(target.agentId))
        .filter(
          (entry): entry is CacheEntry => entry?.value === undefined && Boolean(entry?.inflight),
        )
        .map((entry) => entry.inflight);
      if (cold.length > 0) {
        const budget = Math.max(0, ctx.timeoutMs - HOST_DEADLINE_MARGIN_MS);
        let timer: NodeJS.Timeout | undefined;
        let onAbort: (() => void) | undefined;
        await Promise.race([
          Promise.allSettled(cold),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, budget);
            onAbort = () => resolve();
            ctx.signal.addEventListener("abort", onAbort, { once: true });
          }),
        ]);
        clearTimeout(timer);
        if (onAbort) {
          ctx.signal.removeEventListener("abort", onAbort);
        }
      }
      return targets.map((target) => present(cache.get(target.agentId) ?? { key: "" }, target));
    },
    invalidate(agentId) {
      for (const [id, entry] of cache) {
        if (agentId === undefined || id === agentId.trim().toLowerCase()) {
          entry.observedAt = undefined;
        }
      }
    },
    dispose() {
      disposed = true;
      for (const entry of cache.values()) {
        entry.abort?.abort();
      }
      cache.clear();
    },
  };
}
