import { describe, expect, test } from "vitest";
import {
  isPluginGatewayMethodGranted,
  parsePluginGatewayMethodGrants,
} from "./server-plugin-gateway-grants.js";

describe("plugin Gateway method grants", () => {
  test("parses exact methods per plugin and skips malformed entries and wildcards", () => {
    const grants = parsePluginGatewayMethodGrants(
      " a = sessions.list , sessions.patch ;b=*; =x ;c; a=session.visibility.set;d=sessions.*",
    );
    expect([...grants.keys()]).toEqual(["a"]);
    expect([...(grants.get("a") ?? [])]).toEqual([
      "sessions.list",
      "sessions.patch",
      "session.visibility.set",
    ]);
    expect(parsePluginGatewayMethodGrants(undefined).size).toBe(0);
  });

  test("grants only the listed plugin and method", () => {
    const env = { OPENCLAW_PLUGIN_GATEWAY_METHODS: "a=sessions.list" };
    expect(isPluginGatewayMethodGranted("a", "sessions.list", env)).toBe(true);
    expect(isPluginGatewayMethodGranted("a", "sessions.delete", env)).toBe(false);
    expect(isPluginGatewayMethodGranted("b", "sessions.list", env)).toBe(false);
    expect(isPluginGatewayMethodGranted(undefined, "sessions.list", env)).toBe(false);
    expect(isPluginGatewayMethodGranted("a", "sessions.list", {})).toBe(false);
  });
});
