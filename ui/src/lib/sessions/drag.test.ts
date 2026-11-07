import { afterEach, describe, expect, it } from "vitest";
import {
  activeCatalogReorderDragData,
  finishCatalogReorderDrag,
  readCatalogReorderDragData,
  sessionDragActive,
  writeCatalogReorderDragData,
} from "./drag.ts";

function fakeDataTransfer(): DataTransfer {
  const data = new Map<string, string>();
  return {
    effectAllowed: "none",
    get types() {
      return [...data.keys()];
    },
    setData: (type: string, value: string) => void data.set(type, value),
    getData: (type: string) => data.get(type) ?? "",
  } as unknown as DataTransfer;
}

describe("catalog reorder drag data", () => {
  afterEach(finishCatalogReorderDrag);

  it("round-trips a row payload under its private MIME type", () => {
    const transfer = fakeDataTransfer();
    const payload = {
      kind: "row" as const,
      catalogId: "claude",
      hostId: "gateway:local",
      group: "Work",
      threadId: "thread-1",
    };

    writeCatalogReorderDragData(transfer, payload);

    expect(transfer.effectAllowed).toBe("move");
    expect(transfer.types).toEqual(["application/x-openclaw-catalog-reorder"]);
    expect(readCatalogReorderDragData(transfer)).toEqual(payload);
    expect(activeCatalogReorderDragData(transfer)).toEqual(payload);
    expect(sessionDragActive(transfer)).toBe(false);
  });

  it("ignores foreign drags, malformed payloads and finished drags", () => {
    const transfer = fakeDataTransfer();
    writeCatalogReorderDragData(transfer, {
      kind: "group",
      catalogId: "claude",
      hostId: "gateway:local",
      group: "Work",
    });

    expect(activeCatalogReorderDragData(fakeDataTransfer())).toBeNull();
    finishCatalogReorderDrag();
    expect(activeCatalogReorderDragData(transfer)).toBeNull();

    const malformed = fakeDataTransfer();
    malformed.setData("application/x-openclaw-catalog-reorder", '{"kind":"row","group":"Work"}');
    expect(readCatalogReorderDragData(malformed)).toBeNull();
    malformed.setData("application/x-openclaw-catalog-reorder", "not json");
    expect(readCatalogReorderDragData(malformed)).toBeNull();
  });
});
