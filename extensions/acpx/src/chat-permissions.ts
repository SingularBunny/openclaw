/**
 * Fork: the composer's Permissions toggle of a chat bound to an ACP agent. `acpx.chat.permissions.get`
 * reports whether the bound ACP session asks for each permission request or allows all of them;
 * `acpx.chat.permissions.set` switches it. Session-scoped: the plugin-wide `permissionMode` and the
 * other sessions stay as they are. Vendor-neutral: any ACP agent bound with `--bind here`.
 */
import type { OpenClawPluginApi } from "../runtime-api.js";
import { resolveChatAcpBinding } from "./chat-handoff.js";
import {
  acpxPermissionModes,
  readAcpxChatPermissionMode,
  type AcpxSessionPermissionModes,
} from "./permission-modes.js";

/**
 * Permission questions reach the chat only with `nonInteractivePermissions: "ask"` and
 * `permissionMode: "approve-reads"` (the defaults); approve-all and deny-all never ask.
 */
export function acpxChatPermissionsAvailable(config: unknown): boolean {
  const record =
    config && typeof config === "object" && !Array.isArray(config)
      ? (config as Record<string, unknown>)
      : {};
  return (
    (record.nonInteractivePermissions ?? "ask") === "ask" &&
    (record.permissionMode ?? "approve-reads") === "approve-reads"
  );
}

function readParams(params: Record<string, unknown>, allowed: readonly string[]) {
  if (Object.keys(params).some((key) => !allowed.includes(key))) {
    return undefined;
  }
  const sessionKey = typeof params.sessionKey === "string" ? params.sessionKey.trim() : "";
  const agentId = typeof params.agentId === "string" ? params.agentId.trim() : "";
  return sessionKey ? { sessionKey, ...(agentId ? { agentId } : {}) } : undefined;
}

export function registerChatPermissions(
  api: OpenClawPluginApi,
  modes: AcpxSessionPermissionModes = acpxPermissionModes,
): void {
  const available = () =>
    acpxChatPermissionsAvailable(api.runtime.config.current().plugins?.entries?.acpx?.config);
  api.registerGatewayMethod(
    "acpx.chat.permissions.get",
    async ({ params, respond }) => {
      const parsed = readParams(params, ["sessionKey", "agentId"]);
      if (!parsed) {
        respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: "acpx.chat.permissions.get takes { sessionKey, agentId? }",
        });
        return;
      }
      try {
        const binding = await resolveChatAcpBinding(parsed.sessionKey, parsed.agentId);
        const target = binding?.targetSessionKey ?? null;
        respond(
          true,
          {
            targetSessionKey: target,
            available: Boolean(target) && available(),
            mode: target ? await modes.get(target) : "ask",
          },
          undefined,
        );
      } catch (error) {
        respond(false, undefined, { code: "UNAVAILABLE", message: String(error) });
      }
    },
    { scope: "operator.read", profileAccess: "independent" },
  );
  // Same scope as answering the questions one by one: allow-all only presses Allow for the user.
  api.registerGatewayMethod(
    "acpx.chat.permissions.set",
    async ({ params, respond }) => {
      const parsed = readParams(params, ["sessionKey", "agentId", "mode"]);
      const mode = readAcpxChatPermissionMode(params.mode);
      if (!parsed || !mode) {
        respond(false, undefined, {
          code: "INVALID_REQUEST",
          message:
            'acpx.chat.permissions.set takes { sessionKey, agentId?, mode: "ask" | "allow-all" }',
        });
        return;
      }
      try {
        const binding = await resolveChatAcpBinding(parsed.sessionKey, parsed.agentId);
        if (!binding) {
          respond(false, undefined, {
            code: "INVALID_REQUEST",
            message: "This chat is not bound to an ACP agent.",
          });
          return;
        }
        if (mode === "allow-all" && !available()) {
          respond(false, undefined, {
            code: "INVALID_REQUEST",
            message:
              "ACP permission questions are off (plugins.entries.acpx.config permissionMode or nonInteractivePermissions), so there is nothing to allow.",
          });
          return;
        }
        await modes.set(binding.targetSessionKey, mode);
        respond(true, { targetSessionKey: binding.targetSessionKey, mode }, undefined);
      } catch (error) {
        respond(false, undefined, { code: "UNAVAILABLE", message: String(error) });
      }
    },
    { scope: "operator.write", profileAccess: "independent" },
  );
}
