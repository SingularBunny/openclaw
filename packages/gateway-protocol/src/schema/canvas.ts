import type { Static } from "typebox";
import { Type } from "typebox";
import { CANVAS_DOCUMENT_PREVIEW_MAX_BYTES, WIDGET_HTML_MAX_UTF8_BYTES } from "../canvas-limits.js";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

export { CANVAS_DOCUMENT_PREVIEW_MAX_BYTES, WIDGET_HTML_MAX_UTF8_BYTES } from "../canvas-limits.js";
/** Key length matches the Claude artifact storage contract. */
export const WIDGET_STORAGE_KEY_MAX_CHARS = 200;
/** One value; the whole namespace is rewritten on every set, so values stay small. */
export const WIDGET_STORAGE_VALUE_MAX_BYTES = 256 * 1024;
/** One widget in one session: 32 retained widgets stay within 32 MiB per session. */
export const WIDGET_STORAGE_TOTAL_MAX_BYTES = 1024 * 1024;
export const WIDGET_STORAGE_MAX_KEYS = 1000;

export const CanvasDocumentPreviewParamsSchema = closedObject({
  html: Type.String({
    maxLength: CANVAS_DOCUMENT_PREVIEW_MAX_BYTES,
    description: "Caller-owned HTML, limited to 2 MiB of UTF-8 data by the Gateway.",
  }),
});

export const CanvasDocumentViewParamsSchema = closedObject({
  docId: Type.String({ minLength: 1, maxLength: 256, pattern: "^(?!\\.{1,2}$)[A-Za-z0-9._-]+$" }),
  sessionKey: Type.Optional(NonEmptyString),
});

export const CanvasDocumentViewResultSchema = closedObject({
  html: Type.String({ maxLength: WIDGET_HTML_MAX_UTF8_BYTES }),
  sandboxUrl: Type.String(),
  sandboxPort: Type.Integer({ minimum: 1, maximum: 65535 }),
  sandboxOrigin: Type.Optional(Type.String()),
});

const CanvasDocumentId = Type.String({
  minLength: 1,
  maxLength: 256,
  pattern: "^(?!\\.{1,2}$)[A-Za-z0-9._-]+$",
});
const WidgetStorageKey = Type.String({
  minLength: 1,
  maxLength: WIDGET_STORAGE_KEY_MAX_CHARS,
  pattern: "^[^\\s\\x00-\\x1f\\x7f/\\\\'\"]+$",
});
const WidgetStorageScope = {
  sessionKey: NonEmptyString,
  agentId: Type.Optional(NonEmptyString),
  docId: CanvasDocumentId,
};

export const CanvasStorageGetParamsSchema = closedObject({
  ...WidgetStorageScope,
  key: WidgetStorageKey,
});

export const CanvasStorageListParamsSchema = closedObject({
  ...WidgetStorageScope,
  prefix: Type.Optional(Type.String({ maxLength: WIDGET_STORAGE_KEY_MAX_CHARS })),
});

export const CanvasStorageSetParamsSchema = closedObject({
  ...WidgetStorageScope,
  key: WidgetStorageKey,
  // Characters bound the frame early; the Gateway enforces the UTF-8 byte limit.
  value: Type.String({ maxLength: WIDGET_STORAGE_VALUE_MAX_BYTES }),
});

export const CanvasStorageDeleteParamsSchema = closedObject({
  ...WidgetStorageScope,
  key: WidgetStorageKey,
});

export type CanvasDocumentPreviewParams = Static<typeof CanvasDocumentPreviewParamsSchema>;
export type CanvasDocumentViewParams = Static<typeof CanvasDocumentViewParamsSchema>;
export type CanvasDocumentViewResult = Static<typeof CanvasDocumentViewResultSchema>;
export type CanvasStorageGetParams = Static<typeof CanvasStorageGetParamsSchema>;
export type CanvasStorageListParams = Static<typeof CanvasStorageListParamsSchema>;
export type CanvasStorageSetParams = Static<typeof CanvasStorageSetParamsSchema>;
export type CanvasStorageDeleteParams = Static<typeof CanvasStorageDeleteParamsSchema>;
