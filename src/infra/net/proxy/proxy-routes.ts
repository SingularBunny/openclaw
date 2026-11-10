// Fork: per-host routing for the managed proxy (`OPENCLAW_PROXY_ROUTES`) and per-backend
// proxy env for CLI agent children (`OPENCLAW_CLI_BACKEND_PROXY`). Both are read on use, so a
// hot env reload takes effect on the next request or the next CLI run.
//
// Route rules: `<host suffixes>=<target>` separated by `;`. Hosts are comma-separated suffixes
// (`anthropic.com` matches `anthropic.com` and `api.anthropic.com`; case-insensitive; a leading
// `.` or `*.` and a trailing dot are ignored) or `*` for every other host. Targets: `proxy` (the
// managed proxy, `proxy.proxyUrl`), `direct`, or an http(s) proxy URL. The in-process router
// (Proxyline) holds one proxy URL, so a URL target must be that managed proxy URL; otherwise the
// whole rule set is rejected and routing stays upstream (everything through the proxy).
// The most specific (longest) matching suffix wins; without a `*` rule other hosts use the proxy.
import { isLoopbackIpAddress } from "@openclaw/net-policy/ip";
import { isHttpUrl } from "@openclaw/net-policy/url-protocol";

export const PROXY_ROUTES_ENV = "OPENCLAW_PROXY_ROUTES";
export const CLI_BACKEND_PROXY_ENV = "OPENCLAW_CLI_BACKEND_PROXY";

/** Where a rule sends matching traffic. URL targets are secrets: never log them. */
export type ProxyRouteTarget =
  | { kind: "proxy" }
  | { kind: "direct" }
  | { kind: "url"; url: string };

export type ProxyRoute = { suffixes: readonly string[]; target: ProxyRouteTarget };

export type ProxyRoutes = {
  routes: readonly ProxyRoute[];
  /** Target of the `*` rule; undefined keeps upstream (proxy) for unmatched hosts. */
  fallback?: ProxyRouteTarget;
};

export type ParsedProxyRoutes = { ok: true; value: ProxyRoutes } | { ok: false; error: string };

/** Parses a route target; the error text never contains the value (it may hold credentials). */
export function parseProxyRouteTarget(raw: string): ProxyRouteTarget | undefined {
  const value = raw.trim();
  const lower = value.toLowerCase();
  if (lower === "proxy") {
    return { kind: "proxy" };
  }
  if (lower === "direct") {
    return { kind: "direct" };
  }
  if (isHttpUrl(value)) {
    return { kind: "url", url: value };
  }
  return undefined;
}

const HOST_SUFFIX_PATTERN =
  /^[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?(\.[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?)*$/;

/** Normalizes one host suffix; undefined when it is not a host name. */
export function normalizeProxyHostSuffix(raw: string): string | undefined {
  const value = raw
    .trim()
    .toLowerCase()
    .replace(/^\*?\./, "")
    .replace(/\.$/, "");
  return HOST_SUFFIX_PATTERN.test(value) ? value : undefined;
}

/** Parses `OPENCLAW_PROXY_ROUTES`. Blank input is "no rules" (upstream). */
export function parseProxyRoutes(raw: string): ParsedProxyRoutes {
  const routes: ProxyRoute[] = [];
  let fallback: ProxyRouteTarget | undefined;
  const rules = raw
    .split(";")
    .map((rule) => rule.trim())
    .filter(Boolean);
  for (const [index, rule] of rules.entries()) {
    const eq = rule.indexOf("=");
    if (eq <= 0) {
      return { ok: false, error: `rule ${index + 1} is not <hosts>=<target>` };
    }
    const target = parseProxyRouteTarget(rule.slice(eq + 1));
    if (!target) {
      return {
        ok: false,
        error: `rule ${index + 1} target must be proxy, direct or an http(s) proxy URL`,
      };
    }
    const hosts = rule
      .slice(0, eq)
      .split(",")
      .map((host) => host.trim())
      .filter(Boolean);
    if (hosts.length === 0) {
      return { ok: false, error: `rule ${index + 1} has no hosts` };
    }
    const suffixes: string[] = [];
    for (const host of hosts) {
      if (host === "*") {
        if (fallback) {
          return { ok: false, error: "more than one * rule" };
        }
        fallback = target;
        continue;
      }
      const suffix = normalizeProxyHostSuffix(host);
      if (!suffix) {
        return {
          ok: false,
          error: `rule ${index + 1} has an invalid host (use host names such as anthropic.com, or *)`,
        };
      }
      suffixes.push(suffix);
    }
    if (suffixes.length > 0) {
      routes.push({ suffixes, target });
    }
  }
  return { ok: true, value: { routes, ...(fallback ? { fallback } : {}) } };
}

function hostMatchesSuffix(host: string, suffix: string): boolean {
  return host === suffix || host.endsWith(`.${suffix}`);
}

/** Returns the target of the most specific rule for a host, or the `*` target. */
export function matchProxyRoute(
  routes: ProxyRoutes,
  hostname: string,
): ProxyRouteTarget | undefined {
  const host = hostname.toLowerCase().replace(/\.+$/, "");
  let best: { length: number; target: ProxyRouteTarget } | undefined;
  for (const route of routes.routes) {
    for (const suffix of route.suffixes) {
      if (hostMatchesSuffix(host, suffix) && (!best || suffix.length > best.length)) {
        best = { length: suffix.length, target: route.target };
      }
    }
  }
  return best?.target ?? routes.fallback;
}

function sameProxyUrl(left: string, right: string | undefined): boolean {
  if (!right) {
    return false;
  }
  const a = URL.parse(left);
  const b = URL.parse(right);
  return a !== null && b !== null && a.href === b.href;
}

let cachedRoutes: { raw: string; parsed: ParsedProxyRoutes } | undefined;

function readParsedProxyRoutes(env: NodeJS.ProcessEnv): ParsedProxyRoutes | undefined {
  const raw = env[PROXY_ROUTES_ENV]?.trim();
  if (!raw) {
    return undefined;
  }
  if (cachedRoutes?.raw !== raw) {
    cachedRoutes = { raw, parsed: parseProxyRoutes(raw) };
  }
  return cachedRoutes.parsed;
}

export type ManagedProxyRouteDecision = "proxy" | "direct";

export type ManagedProxyRouteResolution =
  | { kind: "unset" }
  | { kind: "invalid"; error: string }
  | { kind: "rules"; decide: (hostname: string) => ManagedProxyRouteDecision };

/**
 * Resolves `OPENCLAW_PROXY_ROUTES` against the active managed proxy URL. URL targets must equal
 * that URL (Proxyline routes through one proxy); a different URL makes the rule set invalid.
 */
export function resolveManagedProxyRoutes(params: {
  env?: NodeJS.ProcessEnv;
  managedProxyUrl: string | undefined;
}): ManagedProxyRouteResolution {
  const parsed = readParsedProxyRoutes(params.env ?? process.env);
  if (!parsed) {
    return { kind: "unset" };
  }
  if (!parsed.ok) {
    return { kind: "invalid", error: parsed.error };
  }
  const targets = [...parsed.value.routes.map((route) => route.target), parsed.value.fallback];
  for (const target of targets) {
    if (target?.kind === "url" && !sameProxyUrl(target.url, params.managedProxyUrl)) {
      return {
        kind: "invalid",
        error:
          "a rule names a proxy URL other than proxy.proxyUrl; in-process routing supports one " +
          "proxy URL (use proxy or direct, or the same URL)",
      };
    }
  }
  const routes = parsed.value;
  return {
    kind: "rules",
    decide: (hostname) =>
      matchProxyRoute(routes, hostname)?.kind === "direct" ? "direct" : "proxy",
  };
}

/** True for localhost and loopback IP hosts; their routing belongs to proxy.loopbackMode. */
export function isLoopbackRouteHost(hostname: string): boolean {
  const host = hostname
    .toLowerCase()
    .replace(/\.+$/, "")
    .replace(/^\[(.*)\]$/, "$1");
  return host === "localhost" || isLoopbackIpAddress(host);
}

/**
 * True when `OPENCLAW_PROXY_ROUTES` sends this URL directly while a managed proxy is active.
 * Loopback hosts, unset or invalid rules, and inactive proxies return false (upstream).
 */
export function isManagedProxyRouteDirect(
  targetUrl: string,
  env: NodeJS.ProcessEnv = process.env,
  managedProxyUrl: string | undefined = env["HTTP_PROXY"],
): boolean {
  if (env["OPENCLAW_PROXY_ACTIVE"] !== "1") {
    return false;
  }
  const url = URL.parse(targetUrl);
  if (!url || isLoopbackRouteHost(url.hostname)) {
    return false;
  }
  const resolution = resolveManagedProxyRoutes({ env, managedProxyUrl });
  return resolution.kind === "rules" && resolution.decide(url.hostname) === "direct";
}

/** API hosts of built-in CLI agent backends, used to default their child proxy env. */
const CLI_BACKEND_API_HOSTS: Readonly<Record<string, string>> = {
  "claude-cli": "api.anthropic.com",
  "google-gemini-cli": "generativelanguage.googleapis.com",
  "codex-cli": "api.openai.com",
  codex: "api.openai.com",
};

export type CliBackendProxyDecision =
  | { kind: "inherit" }
  | { kind: "direct" }
  | { kind: "url"; url: string };

/** Parses `OPENCLAW_CLI_BACKEND_PROXY` (`<backend id>=<proxy|direct|url>;...`). */
export function parseCliBackendProxy(
  raw: string,
): { ok: true; value: Map<string, ProxyRouteTarget> } | { ok: false; error: string } {
  const value = new Map<string, ProxyRouteTarget>();
  const rules = raw
    .split(";")
    .map((rule) => rule.trim())
    .filter(Boolean);
  for (const [index, rule] of rules.entries()) {
    const eq = rule.indexOf("=");
    const id = eq > 0 ? rule.slice(0, eq).trim().toLowerCase() : "";
    const target = eq > 0 ? parseProxyRouteTarget(rule.slice(eq + 1)) : undefined;
    if (!id || !/^[a-z0-9][a-z0-9._-]*$/.test(id) || !target) {
      return {
        ok: false,
        error: `rule ${index + 1} is not <backend id>=<proxy|direct|http(s) proxy URL>`,
      };
    }
    value.set(id, target);
  }
  return { ok: true, value };
}

/**
 * Decides the proxy env of a CLI backend child. An explicit `OPENCLAW_CLI_BACKEND_PROXY` rule
 * wins; otherwise a known backend follows `OPENCLAW_PROXY_ROUTES` for its API host while a managed
 * proxy is active; anything else inherits the Gateway env (upstream).
 */
export function resolveCliBackendProxy(
  backendId: string,
  env: NodeJS.ProcessEnv = process.env,
): CliBackendProxyDecision {
  const id = backendId.trim().toLowerCase();
  const raw = env[CLI_BACKEND_PROXY_ENV]?.trim();
  if (raw) {
    const parsed = parseCliBackendProxy(raw);
    const target = parsed.ok ? parsed.value.get(id) : undefined;
    if (target) {
      return target.kind === "proxy" ? { kind: "inherit" } : target;
    }
  }
  const apiHost = CLI_BACKEND_API_HOSTS[id];
  if (apiHost && isManagedProxyRouteDirect(`https://${apiHost}/`, env)) {
    return { kind: "direct" };
  }
  return { kind: "inherit" };
}

const CHILD_PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "http_proxy",
  "https_proxy",
  "ALL_PROXY",
  "all_proxy",
] as const;
const CHILD_MANAGED_PROXY_KEYS = [
  "OPENCLAW_PROXY_ACTIVE",
  "OPENCLAW_PROXY_LOOPBACK_MODE",
  "OPENCLAW_PROXY_CA_FILE",
] as const;
const CHILD_LOOPBACK_NO_PROXY = "127.0.0.1,localhost,localhost.,::1,[::1],127.0.0.0/8";

/** Applies a CLI backend proxy decision to a child env in place. */
export function applyCliBackendProxyEnv(
  childEnv: Record<string, string | undefined>,
  decision: CliBackendProxyDecision,
): void {
  if (decision.kind === "inherit") {
    return;
  }
  for (const key of [...CHILD_PROXY_ENV_KEYS, ...CHILD_MANAGED_PROXY_KEYS]) {
    delete childEnv[key];
  }
  if (decision.kind === "direct") {
    delete childEnv["NO_PROXY"];
    delete childEnv["no_proxy"];
    return;
  }
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) {
    childEnv[key] = decision.url;
  }
  childEnv["NO_PROXY"] = CHILD_LOOPBACK_NO_PROXY;
  childEnv["no_proxy"] = CHILD_LOOPBACK_NO_PROXY;
}
