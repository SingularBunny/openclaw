import { expect, it } from "vitest";
import { resolveSessionRenameValue } from "./session-rename.ts";

it("prefills the rename of an imported catalog chat with the title shown in the tree", () => {
  expect(
    resolveSessionRenameValue({
      key: "agent:main:catalog-import:abc123",
      displayName: "Report improvements",
    }),
  ).toBe("Report improvements");
  expect(
    resolveSessionRenameValue({
      key: "agent:main:catalog-import:abc123",
      label: "Own label",
      displayName: "Report improvements",
    }),
  ).toBe("Own label");
  expect(resolveSessionRenameValue({ key: "agent:main:telegram:direct:1", displayName: "x" })).toBe(
    "",
  );
});
