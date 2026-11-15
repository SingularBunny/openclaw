import { describe, expect, it } from "vitest";
import { pdfCliPrompt } from "./pdf-tool.cli.js";
import { buildPdfExtractionContext } from "./pdf-tool.helpers.js";

// Fork: the pdf tool's extraction context for a PDF model on a CLI runtime (Claude by subscription).
describe("pdfCliPrompt", () => {
  it("keeps the extracted text, the scanned page images and the question, in order", () => {
    const context = buildPdfExtractionContext("What is the total?", [
      { text: "Invoice 7731", images: [] },
      { text: "", images: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }] },
    ]);
    const { prompt, images } = pdfCliPrompt(context);
    expect(prompt).toContain("Invoice 7731");
    expect(prompt.trimEnd().endsWith("What is the total?")).toBe(true);
    expect(images).toEqual([{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }]);
  });

  it("sends no images for a text PDF", () => {
    expect(
      pdfCliPrompt(buildPdfExtractionContext("Q?", [{ text: "body", images: [] }])).images,
    ).toEqual([]);
  });
});
