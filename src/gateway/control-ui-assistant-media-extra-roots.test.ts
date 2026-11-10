import fs from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import os from "node:os";
import path from "node:path";
import { finished } from "node:stream/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { withEnvAsync } from "../test-utils/env.js";
import { ASSISTANT_MEDIA_ROOTS_ENV } from "./assistant-media-extra-roots.js";
import { handleControlUiAssistantMediaRequest } from "./control-ui.js";
import { makeMockHttpResponse } from "./test-http-response.js";

// Fork: OPENCLAW_ASSISTANT_MEDIA_ROOTS through the real assistant-media HTTP boundary.
const state = vi.hoisted(() => ({
  loaded: vi.fn(),
  retained: vi.fn(),
  config: undefined as OpenClawConfig | undefined,
  auth: vi.fn(),
  placements: vi.fn(),
  placementsAsync: vi.fn(),
}));
vi.mock("./session-utils-store-worker.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-utils-store-worker.js")>()),
  loadGatewaySessionEntryReadOnlyInWorker: async (params: { key: string }) =>
    state.loaded(params.key),
}));
vi.mock("../config/sessions/session-entry-read-facts.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/sessions/session-entry-read-facts.js")>()),
  readRetainedSessionEntryFacts: (_database: unknown, selection: unknown) =>
    state.retained(selection),
}));
vi.mock("../config/io.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/io.js")>()),
  getRuntimeConfig: () => state.config ?? {},
}));
vi.mock("./http-utils.js", () => ({ authorizeControlUiReadRequestOrReply: state.auth }));
vi.mock("./session-worker-placement-context.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-worker-placement-context.js")>()),
  resolveSessionWorkerPlacementContext: () => ({
    workerSessionPlacementService: {
      getMany: state.placements,
      getManyAsync: state.placementsAsync,
    },
  }),
}));

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const NOTES = "# Notes\n\nplain markdown, not an image\n";
const sessionKey = "agent:main:dashboard:extra-roots";
let temp: string;
let project: string;
let extra: string;
let outside: string;
let cfg: OpenClawConfig;
let entry: {
  sessionId: string;
  spawnedCwd?: string;
  sessionRoot?: string;
  permissionMode?: "full" | "workspace";
  execNode?: string;
};

beforeEach(async () => {
  state.placements.mockReset().mockReturnValue(new Map());
  state.placementsAsync
    .mockReset()
    .mockImplementation(async (sessionIds: readonly string[]) => state.placements(sessionIds));
  temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "assistant-extra-roots-")));
  project = path.join(temp, "project");
  extra = path.join(temp, "downloads");
  outside = path.join(temp, "elsewhere");
  for (const directory of [project, extra, outside]) {
    await fs.mkdir(directory);
  }
  cfg = {
    agents: { entries: { main: { workspace: path.join(temp, "agent") } } },
    tools: { fs: { workspaceOnly: true } },
  };
  state.config = cfg;
  entry = { sessionId: "session-one", spawnedCwd: project, sessionRoot: project };
  entry.permissionMode = "full";
  state.loaded.mockImplementation((requestedKey: string) => ({
    cfg,
    agentId: "main",
    canonicalKey: requestedKey,
    storePath: path.join(temp, "sessions.json"),
    entry,
  }));
  state.retained.mockImplementation(({ sessionKeys }: { sessionKeys: string[] }) => ({
    entries: sessionKeys.map((key) => ({ sessionKey: key, entry })),
  }));
  state.auth.mockResolvedValue({
    authMethod: "token",
    operatorScopes: ["operator.admin", "operator.read"],
  });
});
afterEach(async () => {
  await closeStateDatabaseForTest();
  await fs.rm(temp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function request(source: string, options: { ticket?: string; bytes?: boolean } = {}) {
  const query = new URLSearchParams({ source, sessionKey, agentId: "main" });
  if (!options.bytes) {
    query.set("meta", "1");
  }
  if (options.ticket) {
    query.set("mediaTicket", options.ticket);
  }
  const response = makeMockHttpResponse();
  const chunks: Buffer[] = [];
  response.res.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
  const completed = finished(response.res);
  await handleControlUiAssistantMediaRequest(
    {
      url: `/__openclaw__/assistant-media?${query}`,
      method: "GET",
      headers: {},
      headersDistinct: {},
    } as IncomingMessage,
    response.res,
    { config: cfg, agentId: "main" },
  );
  await completed;
  const bytes = Buffer.concat(chunks);
  const body = bytes.toString("utf8");
  return {
    ...response,
    bytes,
    payload: body.startsWith("{") ? (JSON.parse(body) as Record<string, unknown>) : null,
  };
}

const withRoots = <T>(value: string | undefined, run: () => Promise<T>) =>
  withEnvAsync({ [ASSISTANT_MEDIA_ROOTS_ENV]: value }, run);

describe("assistant media extra roots (OPENCLAW_ASSISTANT_MEDIA_ROOTS)", () => {
  it("serves a non-image file from an extra root in a Full Access session", async () => {
    const source = path.join(extra, "notes.md");
    await fs.writeFile(source, NOTES);
    await withRoots(extra, async () => {
      const metadata = (await request(source)).payload!;
      expect(metadata).toMatchObject({ available: true, mediaTicket: expect.any(String) });
      const bytes = await request(source, { ticket: String(metadata.mediaTicket), bytes: true });
      expect(bytes.res.statusCode).toBe(200);
      expect(bytes.bytes.toString("utf8")).toBe(NOTES);
    });
  });

  it("keeps files outside every root image-only", async () => {
    const text = path.join(outside, "notes.md");
    const image = path.join(outside, "image.png");
    await fs.writeFile(text, NOTES);
    await fs.writeFile(image, PNG);
    await withRoots(extra, async () => {
      expect((await request(text)).payload).toMatchObject({ available: false });
      expect((await request(image)).payload).toMatchObject({ available: true });
    });
  });

  it("does not follow a symlink from an extra root to an outside non-image file", async () => {
    const target = path.join(outside, "secret.txt");
    await fs.writeFile(target, "outside text");
    const link = path.join(extra, "link.txt");
    await fs.symlink(target, link);
    await withRoots(extra, async () => {
      expect((await request(link)).payload).toMatchObject({ available: false });
    });
  });

  it("accepts an extra root given through a symlinked folder", async () => {
    const alias = path.join(temp, "alias");
    await fs.symlink(extra, alias);
    const source = path.join(extra, "plugin.zip");
    await fs.writeFile(source, "PK not really a zip");
    await withRoots(alias, async () => {
      expect((await request(source)).payload).toMatchObject({ available: true });
      expect((await request(path.join(alias, "plugin.zip"))).payload).toMatchObject({
        available: true,
      });
    });
  });

  it("leaves workspace-only sessions on upstream behaviour", async () => {
    entry.permissionMode = "workspace";
    const text = path.join(extra, "notes.md");
    const image = path.join(extra, "image.png");
    await fs.writeFile(text, NOTES);
    await fs.writeFile(image, PNG);
    await withRoots(extra, async () => {
      expect((await request(text)).payload).toMatchObject({ available: false });
      expect((await request(image)).payload).toMatchObject({
        available: false,
        code: "outside-allowed-folders",
        canAllow: true,
      });
    });
  });

  it("does not expose extra roots to sessions running on another computer", async () => {
    entry.execNode = "remote-node";
    const source = path.join(extra, "notes.md");
    await fs.writeFile(source, NOTES);
    await withRoots(extra, async () => {
      expect((await request(source)).payload).toMatchObject({ available: false });
    });
  });

  it("serves an agent's own folders only in that agent's sessions, plus the * folders", async () => {
    const shared = path.join(temp, "shared");
    await fs.mkdir(shared);
    const own = path.join(extra, "notes.md");
    const common = path.join(shared, "report.txt");
    await fs.writeFile(own, NOTES);
    await fs.writeFile(common, "shared text");
    await withRoots(`*=${shared};other=${extra}`, async () => {
      expect((await request(own)).payload).toMatchObject({ available: false });
      expect((await request(common)).payload).toMatchObject({ available: true });
    });
    await withRoots(`${shared};main=${extra}`, async () => {
      expect((await request(own)).payload).toMatchObject({ available: true });
      expect((await request(common)).payload).toMatchObject({ available: true });
    });
  });

  it("reads the setting on each request (hot reload) and revokes old tickets", async () => {
    const source = path.join(extra, "notes.md");
    await fs.writeFile(source, NOTES);
    await withRoots(undefined, async () => {
      expect((await request(source)).payload).toMatchObject({ available: false });
    });
    const ticket = await withRoots(extra, async () => {
      const metadata = (await request(source)).payload!;
      expect(metadata).toMatchObject({ available: true });
      return String(metadata.mediaTicket);
    });
    await withRoots(undefined, async () => {
      expect((await request(source, { ticket, bytes: true })).res.statusCode).toBe(404);
    });
  });
});
