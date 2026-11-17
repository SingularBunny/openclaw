import path from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { listAgentsForGateway } from "./session-utils-store.js";
import { closeSessionSqliteDatabasesForTest } from "./session-utils.test-support.js";

afterAll(closeSessionSqliteDatabasesForTest);

// Fork: agents.list reports each agent's run folder so the Control UI can match folder-keyed
// catalog chats to the agent that works there.
describe("listAgentsForGateway run cwd", () => {
  test("reports an agent's own cwd and omits it when none is configured", async () => {
    const shopCwd = path.resolve("/projects/chats/shop");
    const cfg = {
      agents: {
        entries: {
          main: {},
          shop: { workspace: path.resolve("/data/projects/shop"), cwd: shopCwd },
        },
      },
    } as OpenClawConfig;
    const { agents } = await listAgentsForGateway(cfg);
    const shop = agents.find((agent) => agent.id === "shop");
    const main = agents.find((agent) => agent.id === "main");
    expect(shop?.cwd).toBe(shopCwd);
    expect(shop?.workspace).toBe(path.resolve("/data/projects/shop"));
    expect(main).toBeDefined();
    expect(main).not.toHaveProperty("cwd");
  });

  test("falls back to the defaults cwd like agent runs do", async () => {
    const shared = path.resolve("/projects/chats");
    const cfg = {
      agents: { defaults: { cwd: shared }, entries: { main: {} } },
    } as OpenClawConfig;
    const { agents } = await listAgentsForGateway(cfg);
    expect(agents.find((agent) => agent.id === "main")?.cwd).toBe(shared);
  });
});
