// Fork: OPENCLAW_PROXY_ROUTES parsing and matching, env-proxy URL checks, and per-backend CLI
// child proxy env (OPENCLAW_CLI_BACKEND_PROXY).
import { describe, expect, it } from "vitest";
import { shouldUseEnvHttpProxyForUrl } from "../proxy-env.js";
import {
  applyCliBackendProxyEnv,
  isManagedProxyRouteDirect,
  matchProxyRoute,
  parseProxyRoutes,
  resolveCliBackendProxy,
  resolveManagedProxyRoutes,
} from "./proxy-routes.js";

const PROXY = "http://127.0.0.1:3128";

function managedEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    OPENCLAW_PROXY_ACTIVE: "1",
    HTTP_PROXY: PROXY,
    HTTPS_PROXY: PROXY,
    NO_PROXY: "127.0.0.1,localhost",
    ...extra,
  };
}

describe("parseProxyRoutes", () => {
  it("parses host suffix rules and the * rule", () => {
    const parsed = parseProxyRoutes(" anthropic.com, .Claude.AI ,*.claude.com.=proxy ; *=direct; ");
    expect(parsed).toEqual({
      ok: true,
      value: {
        routes: [
          { suffixes: ["anthropic.com", "claude.ai", "claude.com"], target: { kind: "proxy" } },
        ],
        fallback: { kind: "direct" },
      },
    });
  });

  it.each([
    ["anthropic.com", "not <hosts>=<target>"],
    ["=proxy", "not <hosts>=<target>"],
    ["anthropic.com=socks5://127.0.0.1:1080", "target must be"],
    ["anthropic.com=maybe", "target must be"],
    ["api.anthropic.com/v1=proxy", "invalid host"],
    ["*=proxy;*=direct", "more than one *"],
  ])("rejects %s", (raw, error) => {
    const parsed = parseProxyRoutes(raw);
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? "" : parsed.error).toContain(error);
  });

  it("never puts a proxy URL into the error text", () => {
    const parsed = parseProxyRoutes("a.com=http://user:secret@10.0.0.1:8080;bad host=proxy");
    expect(parsed.ok ? "" : parsed.error).not.toContain("secret");
  });
});

describe("matchProxyRoute", () => {
  const routes = (raw: string) => {
    const parsed = parseProxyRoutes(raw);
    if (!parsed.ok) {
      throw new Error(parsed.error);
    }
    return parsed.value;
  };

  it("matches the host and its subdomains only, case-insensitively", () => {
    const value = routes("anthropic.com=proxy");
    expect(matchProxyRoute(value, "anthropic.com")?.kind).toBe("proxy");
    expect(matchProxyRoute(value, "API.Anthropic.com.")?.kind).toBe("proxy");
    expect(matchProxyRoute(value, "notanthropic.com")).toBeUndefined();
    expect(matchProxyRoute(value, "anthropic.com.evil.net")).toBeUndefined();
  });

  it("prefers the most specific suffix and falls back to *", () => {
    const value = routes("*=direct;example.com=proxy;cdn.example.com=direct");
    expect(matchProxyRoute(value, "www.example.com")?.kind).toBe("proxy");
    expect(matchProxyRoute(value, "a.cdn.example.com")?.kind).toBe("direct");
    expect(matchProxyRoute(value, "other.org")?.kind).toBe("direct");
  });
});

describe("resolveManagedProxyRoutes", () => {
  it("is unset without the variable and rejects URLs other than the managed proxy", () => {
    expect(resolveManagedProxyRoutes({ env: {}, managedProxyUrl: PROXY }).kind).toBe("unset");
    const other = resolveManagedProxyRoutes({
      env: { OPENCLAW_PROXY_ROUTES: "openai.com=http://10.0.0.2:8080" },
      managedProxyUrl: PROXY,
    });
    expect(other.kind).toBe("invalid");
    const same = resolveManagedProxyRoutes({
      env: { OPENCLAW_PROXY_ROUTES: "openai.com=http://127.0.0.1:3128/;*=direct" },
      managedProxyUrl: PROXY,
    });
    expect(same.kind === "rules" && same.decide("api.openai.com")).toBe("proxy");
    expect(same.kind === "rules" && same.decide("example.org")).toBe("direct");
  });
});

describe("isManagedProxyRouteDirect and shouldUseEnvHttpProxyForUrl", () => {
  const routes = "anthropic.com,claude.ai,claude.com=proxy;*=direct";

  it("sends unlisted hosts directly only while a managed proxy is active", () => {
    const env = managedEnv({ OPENCLAW_PROXY_ROUTES: routes });
    expect(isManagedProxyRouteDirect("https://api.github.com/", env)).toBe(true);
    expect(shouldUseEnvHttpProxyForUrl("https://api.github.com/", env)).toBe(false);
    expect(shouldUseEnvHttpProxyForUrl("https://api.anthropic.com/v1/messages", env)).toBe(true);
    // Not a managed proxy: plain operator HTTP(S)_PROXY keeps upstream semantics.
    const ambient = { ...env, OPENCLAW_PROXY_ACTIVE: undefined };
    expect(shouldUseEnvHttpProxyForUrl("https://api.github.com/", ambient)).toBe(true);
  });

  it("keeps upstream routing when unset or invalid, and leaves loopback alone", () => {
    expect(shouldUseEnvHttpProxyForUrl("https://api.github.com/", managedEnv())).toBe(true);
    const invalid = managedEnv({ OPENCLAW_PROXY_ROUTES: "github.com=nonsense" });
    expect(shouldUseEnvHttpProxyForUrl("https://api.github.com/", invalid)).toBe(true);
    const all = managedEnv({ OPENCLAW_PROXY_ROUTES: "*=direct" });
    expect(isManagedProxyRouteDirect("http://[::1]:18789/", all)).toBe(false);
    expect(isManagedProxyRouteDirect("http://localhost:18789/", all)).toBe(false);
  });
});

describe("CLI backend child proxy env", () => {
  it("defaults known backends to the route of their API host", () => {
    const env = managedEnv({ OPENCLAW_PROXY_ROUTES: "anthropic.com=proxy;*=direct" });
    expect(resolveCliBackendProxy("claude-cli", env)).toEqual({ kind: "inherit" });
    expect(resolveCliBackendProxy("google-gemini-cli", env)).toEqual({ kind: "direct" });
    expect(resolveCliBackendProxy("custom-cli", env)).toEqual({ kind: "inherit" });
    expect(resolveCliBackendProxy("google-gemini-cli", managedEnv())).toEqual({ kind: "inherit" });
  });

  it("lets OPENCLAW_CLI_BACKEND_PROXY win per backend", () => {
    const env = managedEnv({
      OPENCLAW_PROXY_ROUTES: "*=direct",
      OPENCLAW_CLI_BACKEND_PROXY: "claude-cli=proxy; google-gemini-cli=http://10.0.0.2:8080",
    });
    expect(resolveCliBackendProxy("claude-cli", env)).toEqual({ kind: "inherit" });
    expect(resolveCliBackendProxy("google-gemini-cli", env)).toEqual({
      kind: "url",
      url: "http://10.0.0.2:8080",
    });
    // Without a managed proxy an explicit URL still applies to that child.
    expect(
      resolveCliBackendProxy("claude-cli", { OPENCLAW_CLI_BACKEND_PROXY: "claude-cli=http://p:1" }),
    ).toEqual({ kind: "url", url: "http://p:1" });
  });

  it("rewrites or strips child proxy env", () => {
    const direct: Record<string, string | undefined> = { ...managedEnv(), PATH: "/bin" };
    applyCliBackendProxyEnv(direct, { kind: "direct" });
    expect(direct).toEqual({ PATH: "/bin" });

    const viaUrl: Record<string, string | undefined> = { ...managedEnv() };
    applyCliBackendProxyEnv(viaUrl, { kind: "url", url: "http://10.0.0.2:8080" });
    expect(viaUrl["HTTPS_PROXY"]).toBe("http://10.0.0.2:8080");
    expect(viaUrl["https_proxy"]).toBe("http://10.0.0.2:8080");
    expect(viaUrl["OPENCLAW_PROXY_ACTIVE"]).toBeUndefined();
    expect(viaUrl["NO_PROXY"]).toContain("127.0.0.1");

    const inherit: Record<string, string | undefined> = { ...managedEnv() };
    applyCliBackendProxyEnv(inherit, { kind: "inherit" });
    expect(inherit).toEqual(managedEnv());
  });
});
