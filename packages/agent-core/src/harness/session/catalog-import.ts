const CATALOG_PRESERVATION_KEY_PREFIX = "catalog-preservation:";
const CATALOG_PRESERVATION_NOTICE_KEY = "catalog-preservation:notice";
// The boundary sessions.catalog.import writes around each preserved row (wrapExternalContent with
// source "unknown", no warning), after the "Thinking"/"Tool call"/... label it may add.
const CATALOG_IMPORT_BOUNDARY =
  /^((?:Thinking|Tool call|Tool result|Other)\n\n)?\n?<<<EXTERNAL_UNTRUSTED_CONTENT id="([0-9a-f]{16})">>>\nSource: External\n---\n([\s\S]*)\n<<<END_EXTERNAL_UNTRUSTED_CONTENT id="\2">>>$/;

/** OPENCLAW_CATALOG_IMPORT_OWNER=1: catalog imports are the owner's own chats. Read on use. */
export function catalogImportIsOwners(): boolean {
  return /^(1|true|yes)$/i.test(process.env.OPENCLAW_CATALOG_IMPORT_OWNER?.trim() ?? "");
}

function unwrapCatalogImportText(text: string): string {
  const match = CATALOG_IMPORT_BOUNDARY.exec(text);
  return match ? `${match[1] ?? ""}${match[3]}` : text;
}

/**
 * Chats imported before the owner opted in keep the untrusted-reference notice and a boundary
 * around every row. For the owner's own chats both are dropped where the model or the chat view
 * reads them, so the chat continues as in the native client. Other rows pass through unchanged.
 */
export function projectOwnerCatalogImport<T>(message: T): T | undefined {
  const key = (message as { idempotencyKey?: unknown } | undefined)?.idempotencyKey;
  if (
    typeof key !== "string" ||
    !key.startsWith(CATALOG_PRESERVATION_KEY_PREFIX) ||
    !catalogImportIsOwners()
  ) {
    return message;
  }
  if (key === CATALOG_PRESERVATION_NOTICE_KEY) {
    return undefined;
  }
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") {
    return { ...message, content: unwrapCatalogImportText(content) };
  }
  if (!Array.isArray(content)) {
    return message;
  }
  return {
    ...message,
    content: content.map((block: unknown) =>
      block &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
        ? { ...block, text: unwrapCatalogImportText((block as { text: string }).text) }
        : block,
    ),
  };
}
