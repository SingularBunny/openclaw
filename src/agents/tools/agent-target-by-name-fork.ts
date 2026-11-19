// Fork: agents call each other by the name the owner sees ("Claude", "Ops"), not only by id.
// Upstream's sessions_create forwarded the raw agentId, so "use agent Claude" failed with
// `Unknown agent id "claude"` when that agent's id is `main`, and agents_list showed no names.
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { listAgentEntries, listAgentIds } from "../agent-scope-config.js";
import { resolveAgentIdentity } from "../identity.js";
import { ToolInputError } from "./common.js";

/** The display name of an agent: its identity name, then the entry name. */
export function agentDisplayName(cfg: OpenClawConfig, agentId: string): string | undefined {
  const id = normalizeAgentId(agentId);
  const entry = listAgentEntries(cfg).find((item) => normalizeAgentId(item.id) === id);
  const name = resolveAgentIdentity(cfg, id)?.name?.trim() || entry?.name?.trim();
  return name || undefined;
}

function describeAgents(cfg: OpenClawConfig): string {
  return listAgentIds(cfg)
    .map((id) => {
      const name = agentDisplayName(cfg, id);
      return name && name.toLowerCase() !== id ? `${id} (${name})` : id;
    })
    .join(", ");
}

/**
 * The configured agent id for a model-supplied target: an id, or a unique display name matched
 * without case. Anything else is passed on unchanged for the Gateway to judge.
 */
export function resolveAgentTargetId(cfg: OpenClawConfig | undefined, raw: string): string {
  if (!cfg) {
    return raw;
  }
  const ids = listAgentIds(cfg);
  const id = normalizeAgentId(raw);
  if (ids.includes(id)) {
    return id;
  }
  const wanted = raw.trim().toLowerCase();
  const byName = ids.filter(
    (candidate) => agentDisplayName(cfg, candidate)?.toLowerCase() === wanted,
  );
  return byName.length === 1 ? byName[0]! : raw;
}

/** An unknown-agent refusal gains the list of agents, so the model can pick one and retry. */
export function withAgentListOnUnknownAgent(
  cfg: OpenClawConfig | undefined,
  error: unknown,
): unknown {
  if (!cfg) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /Unknown agent id/i.test(message)
    ? new ToolInputError(`${message}. Agents (id (name)): ${describeAgents(cfg)}.`)
    : error;
}
