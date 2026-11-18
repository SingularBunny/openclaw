import { getSafeLocalStorage } from "../local-storage.ts";

/**
 * Fork: catalog folders (Projects tree) whose "Show more" is open. Kept apart from the
 * page-size limits that session refreshes, filters and agent switches reset, and stored
 * like collapsed sections so the choice survives row updates, navigation and reload.
 */
export const SIDEBAR_EXPANDED_CATALOG_SECTIONS_STORAGE_KEY =
  "openclaw:sidebar:sessions:expanded-catalog-sections";

// Old folders drop off first; a long-lived browser never grows the entry without bound.
const MAX_STORED_SECTIONS = 200;

export function loadStoredExpandedCatalogSections(): ReadonlySet<string> {
  try {
    const raw = getSafeLocalStorage()?.getItem(SIDEBAR_EXPANDED_CATALOG_SECTIONS_STORAGE_KEY);
    const parsed: unknown = raw == null ? [] : JSON.parse(raw);
    return new Set(
      Array.isArray(parsed)
        ? parsed.filter((value): value is string => typeof value === "string" && value !== "")
        : [],
    );
  } catch {
    return new Set();
  }
}

/** Returns the next set and stores it; storage failures keep the in-memory choice. */
export function setCatalogSectionExpanded(
  current: ReadonlySet<string>,
  sectionId: string,
  expanded: boolean,
): ReadonlySet<string> {
  const next = new Set(current);
  next.delete(sectionId);
  if (expanded) {
    next.add(sectionId);
  }
  const stored = [...next].slice(-MAX_STORED_SECTIONS);
  try {
    getSafeLocalStorage()?.setItem(
      SIDEBAR_EXPANDED_CATALOG_SECTIONS_STORAGE_KEY,
      JSON.stringify(stored),
    );
  } catch {
    // Private mode or a full store: the folder stays expanded for this page only.
  }
  return new Set(stored);
}

/** Host-owned state: the sidebar re-renders through `requestUpdate` after each change. */
export class CatalogExpandedSections {
  sections: ReadonlySet<string> = loadStoredExpandedCatalogSections();

  constructor(private readonly host: { requestUpdate(): void }) {}

  set(sectionId: string, expanded: boolean): void {
    this.sections = setCatalogSectionExpanded(this.sections, sectionId, expanded);
    this.host.requestUpdate();
  }
}
