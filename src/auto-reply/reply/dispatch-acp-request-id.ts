import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { generateSecureUuid } from "../../infra/secure-random.js";
import type { FinalizedRuntimeMsgContext } from "../templating.js";

export function resolveAcpRequestId(ctx: FinalizedRuntimeMsgContext): string {
  const id = ctx.MessageSidFull ?? ctx.MessageSid ?? ctx.MessageSidFirst ?? ctx.MessageSidLast;
  return (
    normalizeOptionalString(id) ??
    (typeof id === "number" || typeof id === "bigint" ? String(id) : generateSecureUuid())
  );
}
