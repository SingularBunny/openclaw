/* @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import {
  SIDEBAR_EXPANDED_CATALOG_SECTIONS_STORAGE_KEY,
  loadStoredExpandedCatalogSections,
  setCatalogSectionExpanded,
} from "./sidebar-catalog-expanded-sections.ts";

describe("sidebar catalog expanded sections", () => {
  afterEach(() => {
    localStorage.clear();
  });

  it("stores expanded folders and folds them back", () => {
    let expanded = setCatalogSectionExpanded(new Set(), "catalog-project:a", true);
    expanded = setCatalogSectionExpanded(expanded, "catalog-project:b", true);
    expect([...loadStoredExpandedCatalogSections()]).toEqual([
      "catalog-project:a",
      "catalog-project:b",
    ]);
    expanded = setCatalogSectionExpanded(expanded, "catalog-project:a", false);
    expect([...expanded]).toEqual(["catalog-project:b"]);
    expect([...loadStoredExpandedCatalogSections()]).toEqual(["catalog-project:b"]);
  });

  it("ignores malformed storage and keeps the newest entries", () => {
    localStorage.setItem(SIDEBAR_EXPANDED_CATALOG_SECTIONS_STORAGE_KEY, "{bad");
    expect(loadStoredExpandedCatalogSections().size).toBe(0);
    localStorage.setItem(SIDEBAR_EXPANDED_CATALOG_SECTIONS_STORAGE_KEY, '["a", 1, ""]');
    expect([...loadStoredExpandedCatalogSections()]).toEqual(["a"]);
    let expanded: ReadonlySet<string> = new Set();
    for (let index = 0; index < 205; index += 1) {
      expanded = setCatalogSectionExpanded(expanded, `s${index}`, true);
    }
    expect(expanded.size).toBe(200);
    expect(expanded.has("s0")).toBe(false);
    expect(expanded.has("s204")).toBe(true);
  });
});
