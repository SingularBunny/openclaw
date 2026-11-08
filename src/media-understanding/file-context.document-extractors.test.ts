// Covers inbound Office attachments handed to plugin document extractors.
import fs from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/types.js";
import type { PluginDocumentExtractorEntry } from "../plugins/document-extractor-types.js";
import { renderInboundDocumentContext } from "./file-context.js";

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const mocks = vi.hoisted(() => ({
  extractors: [] as PluginDocumentExtractorEntry[],
}));

// mock-isolation: the resolver answers with the fixture extractors, as if a plugin registered them.
vi.mock("../plugins/document-extractors.runtime.js", () => ({
  resolvePluginDocumentExtractors: () => mocks.extractors,
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

/** Minimal stored ZIP with the entries that identify a Word document. */
function docxBytes(): Buffer {
  const entries = [
    ["[Content_Types].xml", "<Types/>"],
    ["word/document.xml", "<w:document/>"],
  ] as const;
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const nameBytes = Buffer.from(name);
    const data = Buffer.from(content);
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const centralSize = centrals.reduce((size, part) => size + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

function officeExtractor(
  extract: PluginDocumentExtractorEntry["extract"],
  mimeTypes: string[] = [DOCX],
): PluginDocumentExtractorEntry {
  return { id: "fixture-office", pluginId: "fixture-office", label: "Office", mimeTypes, extract };
}

async function renderDocx(params: { cfg?: OpenClawConfig; maxChars?: number } = {}) {
  const workspaceDir = tempDirs.make("openclaw-office-context-");
  const mediaPath = path.join(workspaceDir, "plan.docx");
  await fs.writeFile(mediaPath, docxBytes());
  const ctx: MsgContext = {
    media: [{ path: mediaPath, contentType: DOCX, fileName: "plan.docx" }],
  };
  return await renderInboundDocumentContext({
    ctx,
    cfg: params.cfg ?? {},
    workspaceDir,
    maxChars: params.maxChars,
  });
}

describe("renderInboundDocumentContext with plugin document extractors", () => {
  beforeEach(() => {
    mocks.extractors = [];
  });

  it("extracts a docx through a registered extractor", async () => {
    const extract = vi.fn(async () => ({ text: "Quarterly plan: ship F20.", images: [] }));
    mocks.extractors = [officeExtractor(extract)];

    const context = await renderDocx();

    expect(extract).toHaveBeenCalledOnce();
    expect(extract.mock.calls[0]?.[0]).toMatchObject({ mimeType: DOCX });
    expect(context.text).toContain(`<file name="plan.docx" mime="${DOCX}">`);
    expect(context.text).toContain("Quarterly plan: ship F20.");
    expect(context.text).toContain("<<<EXTERNAL_UNTRUSTED_CONTENT");
    expect(context.text).not.toContain("Unsupported document format");
    expect(context.images).toEqual([]);
  });

  it("marks extracted Office text as partial at the character limit", async () => {
    mocks.extractors = [
      officeExtractor(async () => ({ text: "Quarterly plan: ship F20.", images: [] })),
    ];

    const context = await renderDocx({ maxChars: 9 });

    expect(context.text).toContain("[Partial document: text truncated.]");
    expect(context.text).toContain("Quarterly");
    expect(context.text).not.toContain("ship F20");
  });

  it.each([
    { name: "no extractor declares the MIME", mimeTypes: ["application/pdf"], extract: undefined },
    { name: "the extractor declines", mimeTypes: [DOCX], extract: async () => null },
    {
      name: "the extractor fails",
      mimeTypes: [DOCX],
      extract: async () => {
        throw new Error("converter crashed");
      },
    },
  ])("keeps the unsupported-format marker when $name", async ({ mimeTypes, extract }) => {
    const fallback = vi.fn(async () => ({ text: "must not appear", images: [] }));
    mocks.extractors = [officeExtractor(extract ?? fallback, mimeTypes)];

    const context = await renderDocx();

    expect(context.text).toContain(`Unsupported document format: ${DOCX}.`);
    expect(context.text).not.toContain("must not appear");
    expect(context.text).not.toContain("converter crashed");
    expect(fallback).not.toHaveBeenCalled();
  });

  it("lets an operator allowlist reject the type before any extractor runs", async () => {
    const extract = vi.fn(async () => ({ text: "must not appear", images: [] }));
    mocks.extractors = [officeExtractor(extract)];

    const context = await renderDocx({
      cfg: {
        gateway: {
          http: { endpoints: { responses: { files: { allowedMimes: ["application/pdf"] } } } },
        },
      },
    });

    expect(context.text).toContain(`[Attachment type not allowed: ${DOCX}]`);
    expect(context.text).not.toContain("must not appear");
    expect(extract).not.toHaveBeenCalled();
  });

  it("extracts an allowlisted Office type", async () => {
    mocks.extractors = [officeExtractor(async () => ({ text: "Allowed plan text.", images: [] }))];

    const context = await renderDocx({
      cfg: {
        gateway: { http: { endpoints: { responses: { files: { allowedMimes: [DOCX] } } } } },
      },
    });

    expect(context.text).toContain("Allowed plan text.");
  });
});
