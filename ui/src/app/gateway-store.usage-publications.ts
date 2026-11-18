import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { ApplicationGatewaySnapshot } from "./gateway.ts";

/** Snapshot patch for a newer usage publication of `chat.metadata.changed`, if any. */
export function readUsagePublicationPatch(
  snapshot: ApplicationGatewaySnapshot,
  payload: unknown,
): Partial<ApplicationGatewaySnapshot> | undefined {
  const publication = asOptionalRecord(payload);
  const agentId = publication?.agentId;
  const usageUpdatedAt = publication?.usageUpdatedAt;
  if (
    typeof agentId === "string" &&
    typeof usageUpdatedAt === "number" &&
    usageUpdatedAt > (snapshot.usagePublications?.[agentId]?.usageUpdatedAt ?? 0)
  ) {
    return {
      usagePublications: {
        ...snapshot.usagePublications,
        [agentId]: {
          usageUpdatedAt,
          committedAt:
            publication?.usageRefreshFailed === true
              ? (snapshot.usagePublications?.[agentId]?.committedAt ?? 0)
              : usageUpdatedAt,
          usageRefreshFailed: publication?.usageRefreshFailed === true || undefined,
        },
      },
    };
  }
  return undefined;
}
