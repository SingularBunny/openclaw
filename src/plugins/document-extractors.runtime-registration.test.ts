// Covers document extractors registered at runtime by installed plugins.
import { afterEach, describe, expect, it } from "vitest";
import type { DocumentExtractorPlugin } from "./document-extractor-types.js";
import { resolvePluginDocumentExtractors } from "./document-extractors.runtime.js";
import { createPluginRecord } from "./loader-records.js";
import { createTestPluginRegistry } from "./registry-runtime.test-helpers.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "./runtime.js";

const OWNER = "fixture-office";
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function registerOwner(extractor: Partial<DocumentExtractorPlugin> = {}) {
  const builder = createTestPluginRegistry();
  const record = createPluginRecord({
    id: OWNER,
    source: "/synthetic/fixture-office/index.js",
    origin: "global",
    enabled: true,
    configSchema: false,
  });
  builder.registry.plugins.push(record);
  const api = builder.createApi(record, { config: {} });
  api.registerDocumentExtractor({
    id: "fixture-office",
    label: "Fixture Office",
    mimeTypes: [DOCX],
    extract: async () => ({ text: "fixture text", images: [] }),
    ...extractor,
  });
  setActivePluginRegistry(builder.registry);
  return { builder, record };
}

afterEach(() => {
  resetPluginRuntimeStateForTest();
});

describe("runtime-registered document extractors", () => {
  it("reaches the resolver with its owning plugin id", async () => {
    const { builder, record } = registerOwner();

    expect(builder.registry.diagnostics).toEqual([]);
    expect(record.documentExtractorIds).toEqual(["fixture-office"]);
    const extractors = resolvePluginDocumentExtractors({ onlyPluginIds: [OWNER] });
    expect(extractors.map(({ id, pluginId, mimeTypes }) => ({ id, pluginId, mimeTypes }))).toEqual([
      { id: "fixture-office", pluginId: OWNER, mimeTypes: [DOCX] },
    ]);
    await expect(
      extractors[0]?.extract({
        buffer: Buffer.from("docx"),
        mimeType: DOCX,
        maxPages: 1,
        maxPixels: 1,
        minTextChars: 1,
      }),
    ).resolves.toEqual({ text: "fixture text", images: [] });
  });

  it("rejects a duplicate extractor id", () => {
    const { builder, record } = registerOwner();
    const api = builder.createApi(record, { config: {} });
    api.registerDocumentExtractor({
      id: "fixture-office",
      label: "Duplicate",
      mimeTypes: [DOCX],
      extract: async () => null,
    });

    expect(builder.registry.documentExtractors).toHaveLength(1);
    expect(builder.registry.diagnostics.map((entry) => entry.message)).toEqual([
      `document extractor already registered: fixture-office (${OWNER})`,
    ]);
  });

  it.each([
    { name: "plugins are disabled", plugins: { enabled: false } },
    { name: "the allowlist excludes the owner", plugins: { allow: ["other-plugin"] } },
    { name: "the owner is denied", plugins: { deny: [OWNER] } },
    { name: "the owner entry is disabled", plugins: { entries: { [OWNER]: { enabled: false } } } },
  ])("skips the extractor when $name", ({ plugins }) => {
    registerOwner();

    expect(
      resolvePluginDocumentExtractors({ config: { plugins }, onlyPluginIds: [OWNER] }),
    ).toStrictEqual([]);
  });
});
