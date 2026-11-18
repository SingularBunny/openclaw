import type { ErrorShape } from "../../packages/gateway-protocol/src/index.js";
import type { ModelCatalogSnapshot } from "../agents/model-catalog.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions/types.js";

// Result types of sessions-patch.ts, kept apart so that module stays within its size limit.
export type SessionPatchProjectionResult =
  | { ok: true; entry: SessionEntry; validateModelSelection?: () => ErrorShape | undefined }
  | { ok: false; error: ErrorShape };

export type SessionPatchPreparation =
  | { kind: "complete"; result: SessionPatchProjectionResult }
  | {
      kind: "model-catalog";
      finish: (catalog: ModelCatalogSnapshot | undefined) => SessionPatchProjectionResult;
    };
