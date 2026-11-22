// Fork: environment switches of the native chat import (continuation limits, owner rows), kept out of
// session-catalog-history-import.ts so upstream ports touch less.

function envPositiveInt(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

// How much of a native chat "continue" carries over. OPENCLAW_CATALOG_CONTINUATION_MAX_ITEMS and
// OPENCLAW_CATALOG_CONTINUATION_MAX_BYTES (e.g. config env.vars) replace the defaults; read on use.
export function sessionCatalogContinuationLimits(defaults: { maxItems: number; maxBytes: number }) {
  return {
    maxItems: envPositiveInt("OPENCLAW_CATALOG_CONTINUATION_MAX_ITEMS", defaults.maxItems),
    maxBytes: envPositiveInt("OPENCLAW_CATALOG_CONTINUATION_MAX_BYTES", defaults.maxBytes),
  };
}

/** OPENCLAW_CATALOG_IMPORT_OWNER=1: imported user rows are the owner's (off by default). */
export function sessionCatalogImportMarksOwner(): boolean {
  return /^(1|true|yes)$/i.test(process.env.OPENCLAW_CATALOG_IMPORT_OWNER?.trim() ?? "");
}
