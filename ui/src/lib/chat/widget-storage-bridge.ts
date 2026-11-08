import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";

export const WIDGET_STORAGE_REQUEST_TYPE = "openclaw:widget-storage-request";
export const WIDGET_STORAGE_RESPONSE_TYPE = "openclaw:widget-storage-response";

// Abuse bound per widget document: generous for saving on every click, but a
// runaway loop cannot turn one frame into a stream of Gateway file writes.
const STORAGE_RATE_WINDOW_MS = 60_000;
const STORAGE_RATE_MAX_REQUESTS = 600;
const STORAGE_RATE_MAX_KEYS = 100;
const storageRequestTimes = new Map<string, number[]>();

type WidgetStorageClient = {
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>;
};

export type WidgetStorageResponse = {
  type: typeof WIDGET_STORAGE_RESPONSE_TYPE;
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
};

function allowStorageRequest(rateKey: string, nowMs: number): boolean {
  const recent = (storageRequestTimes.get(rateKey) ?? []).filter(
    (time) => nowMs - time < STORAGE_RATE_WINDOW_MS,
  );
  if (recent.length >= STORAGE_RATE_MAX_REQUESTS) {
    storageRequestTimes.set(rateKey, recent);
    return false;
  }
  recent.push(nowMs);
  storageRequestTimes.delete(rateKey);
  storageRequestTimes.set(rateKey, recent);
  while (storageRequestTimes.size > STORAGE_RATE_MAX_KEYS) {
    storageRequestTimes.delete(storageRequestTimes.keys().next().value!);
  }
  return true;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "widget storage request failed";
}

/**
 * Answers one storage request from an inline widget's private prompt port.
 * The widget supplies only the operation and its key/value; the session and
 * document come from the transcript row that hosts the frame, so a widget can
 * reach no namespace but its own. Without a current scope (disconnected or
 * replaced view) the request fails with `unavailableReason` instead of leaving
 * the widget waiting.
 * Returns undefined for non-storage messages.
 */
export async function handleWidgetStorageRequest(
  data: unknown,
  scope: { client: WidgetStorageClient; sessionKey: string; docId: string } | undefined,
  unavailableReason = "widget storage unavailable",
): Promise<WidgetStorageResponse | undefined> {
  const message = asOptionalRecord(data);
  if (
    message?.type !== WIDGET_STORAGE_REQUEST_TYPE ||
    typeof message.id !== "string" ||
    message.id.length === 0 ||
    message.id.length > 128
  ) {
    return undefined;
  }
  const id = message.id;
  const fail = (error: string): WidgetStorageResponse => ({
    type: WIDGET_STORAGE_RESPONSE_TYPE,
    id,
    ok: false,
    error,
  });
  const method = message.method;
  const params = asOptionalRecord(message.params);
  if (
    (method !== "get" && method !== "set" && method !== "delete" && method !== "list") ||
    !params
  ) {
    return fail("widget storage request is invalid");
  }
  if (!scope?.sessionKey) {
    return fail(unavailableReason);
  }
  if (!allowStorageRequest(`${scope.sessionKey}\0${scope.docId}`, Date.now())) {
    return fail("widget storage rate limit exceeded");
  }
  const request: Record<string, unknown> = { sessionKey: scope.sessionKey, docId: scope.docId };
  // Copy only the fields each operation accepts; the Gateway validates them again.
  if (method === "list") {
    if (params.prefix !== undefined) {
      request.prefix = params.prefix;
    }
  } else {
    request.key = params.key;
    if (method === "set") {
      if (typeof params.value !== "string") {
        return fail("widget storage values must be strings");
      }
      request.value = params.value;
    }
  }
  try {
    const result = await scope.client.request(`canvas.storage.${method}`, request);
    return { type: WIDGET_STORAGE_RESPONSE_TYPE, id, ok: true, result };
  } catch (error) {
    return fail(errorMessage(error));
  }
}

/** Why a widget without a current, session-bound host cannot use storage. */
function describeUnavailableStorage(hasSession: boolean, connected: boolean): string {
  if (!hasSession) {
    return "widget storage is not available for this widget";
  }
  return connected ? "widget storage unavailable" : "Gateway is disconnected";
}

/**
 * Answers one prompt-port message if it is a storage request. Widget code may
 * swallow the rejection, so a failure that is delivered also reaches `notice`.
 * `reply` returns false when the port is no longer current.
 */
export function serveWidgetStorageRequest(
  data: unknown,
  options: {
    scope: Parameters<typeof handleWidgetStorageRequest>[1];
    hasSession: boolean;
    connected: boolean;
    notice: WidgetStorageFailureNotice;
    reply: (response: WidgetStorageResponse) => boolean | void;
  },
): void {
  void handleWidgetStorageRequest(
    data,
    options.scope,
    describeUnavailableStorage(options.hasSession, options.connected),
  ).then((response) => {
    if (response && options.reply(response) !== false) {
      options.notice.recordResponse(data, response);
    }
  });
}

/**
 * One user-visible notice per widget for storage failures. Widget code often
 * swallows rejected storage promises, so the host shows what was lost. Repeats
 * of the shown or a dismissed message are coalesced; a later successful write
 * proves storage works again and clears both.
 */
export class WidgetStorageFailureNotice {
  message = "";
  private readonly dismissed = new Set<string>();

  constructor(
    private readonly format: (kind: "save" | "load", reason: string) => string,
    private readonly onChange: () => void,
  ) {}

  /** Records the outcome of one widget storage operation. */
  record(method: unknown, outcome: { ok: boolean; error?: string }): void {
    const write = method !== "get" && method !== "list";
    if (outcome.ok) {
      if (write && (this.message || this.dismissed.size > 0)) {
        this.dismissed.clear();
        this.update("");
      }
      return;
    }
    const message = this.format(
      write ? "save" : "load",
      outcome.error || "widget storage request failed",
    );
    if (!this.dismissed.has(message)) {
      this.update(message);
    }
  }

  /** Records a widget storage response; other port messages are ignored. */
  recordResponse(data: unknown, response: WidgetStorageResponse | undefined): void {
    if (response) {
      this.record(asOptionalRecord(data)?.method, response);
    }
  }

  dismiss(): void {
    if (this.message) {
      this.dismissed.add(this.message);
      this.update("");
    }
  }

  reset(): void {
    this.dismissed.clear();
    this.update("");
  }

  private update(message: string): void {
    if (this.message !== message) {
      this.message = message;
      this.onChange();
    }
  }
}
