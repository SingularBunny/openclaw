import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { diffGatewayReloadPaths } from "./config-diff.js";
import { FORK_HOT_ENV_VARS } from "./config-reload-fork-env.js";
import {
  buildGatewayReloadPlan,
  isNoopGatewayReloadPlan,
  listConfigReloadRefinementPrefixes,
  resolveConfigReloadMetadata,
} from "./config-reload-plan.js";

const planFor = (prev: OpenClawConfig, next: OpenClawConfig) =>
  buildGatewayReloadPlan(diffGatewayReloadPaths(prev, next, listConfigReloadRefinementPrefixes()));

describe("fork env.vars reload policy", () => {
  beforeEach(() => setActivePluginRegistry(createEmptyPluginRegistry()));
  afterEach(() => resetPluginRuntimeStateForTest());

  it.each(FORK_HOT_ENV_VARS)("hot-applies %s without a Gateway restart", (name) => {
    for (const path of [`env.vars.${name}`, `env.${name}`]) {
      expect(resolveConfigReloadMetadata(path), path).toEqual({ kind: "hot" });
      const plan = buildGatewayReloadPlan([path]);
      expect(plan.restartGateway, path).toBe(false);
      expect(plan.hotReasons, path).toEqual([path]);
      // A hot plan reaches the runtime commit that publishes process.env.
      expect(isNoopGatewayReloadPlan(plan), path).toBe(false);
      expect(plan.reloadPlugins, path).toBe(false);
    }
  });

  it("keeps upstream restarts for other env changes", () => {
    for (const path of [
      "env.vars.PATH",
      "env.vars.OPENCLAW_GATEWAY_TOKEN",
      "env.vars.OPENCLAW_WORKER_PENDING_TASKS_EXTRA",
      "env.shellEnv.enabled",
      "env.vars",
      "env",
    ]) {
      expect(resolveConfigReloadMetadata(path), path).toEqual({ kind: "restart" });
      expect(buildGatewayReloadPlan([path]).restartGateway, path).toBe(true);
    }
  });

  it("hot-applies the installer's writes, also when env.vars did not exist yet", () => {
    const vars = {
      OPENCLAW_SESSION_OBSERVER_MIN_INTERVAL_MS: "90000",
      OPENCLAW_ACTIVITY_RECAP_MIN_INTERVAL_MS: "600000",
    };
    for (const prev of [{}, { env: {} }, { env: { vars: {} } }] as OpenClawConfig[]) {
      const plan = planFor(prev, { env: { vars } });
      expect(plan.restartGateway, JSON.stringify(prev)).toBe(false);
      expect(plan.hotReasons.toSorted()).toEqual([
        "env.vars.OPENCLAW_ACTIVITY_RECAP_MIN_INTERVAL_MS",
        "env.vars.OPENCLAW_SESSION_OBSERVER_MIN_INTERVAL_MS",
      ]);
    }
    // Removing the setting is hot as well.
    expect(planFor({ env: { vars } }, {}).restartGateway).toBe(false);
  });

  it("restarts when a fork variable changes together with another env variable", () => {
    const plan = planFor(
      { env: { vars: { OPENCLAW_CLAUDE_CHROME: "0" } } },
      { env: { vars: { OPENCLAW_CLAUDE_CHROME: "1", HTTPS_PROXY: "http://127.0.0.1:1" } } },
    );
    expect(plan.restartGateway).toBe(true);
    expect(plan.restartReasons).toEqual(["env.vars.HTTPS_PROXY"]);
  });
});
