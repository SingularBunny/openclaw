/**
 * One-shot ACP usage probe: starts the agent in a throwaway directory, opens a
 * session, sends its usage slash command (for example `/stats`), collects the
 * reply text, closes the session and stops the process. The command must be one
 * the agent advertises, so an agent without it never receives a model prompt.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** Commands probed, in order, when the config names none. */
export const DEFAULT_USAGE_COMMANDS = ["usage", "stats"] as const;

export type AcpUsageProbeParams = {
  /** Agent argv: command first, then its arguments. */
  argv: readonly string[];
  /** Slash command without the slash; unset picks the first advertised default. */
  command?: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  /** How long to wait for the agent's command list after the session opens. */
  commandsWaitMs?: number;
};

export class AcpUsageProbeError extends Error {
  constructor(
    message: string,
    readonly reason: "not-installed" | "logged-out" | "unsupported" | "timeout" | "failed",
  ) {
    super(message);
    this.name = "AcpUsageProbeError";
  }
}

type JsonRpcMessage = {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
};

const STDERR_TAIL_CHARS = 2000;
const CLOSE_WAIT_MS = 1500;
const KILL_GRACE_MS = 2000;
const ACP_AUTH_REQUIRED = -32000;

function isAuthError(error: JsonRpcMessage["error"]): boolean {
  return (
    error?.code === ACP_AUTH_REQUIRED ||
    /\b(auth|authenticat|log ?in|sign ?in|unauthori[sz]ed)/i.test(error?.message ?? "")
  );
}

function killTree(child: ChildProcess, signal: NodeJS.Signals) {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) {
    return;
  }
  try {
    if (process.platform !== "win32") {
      // The agent may start helpers (a JVM, a node runtime); stop its whole group.
      process.kill(-child.pid, signal);
      return;
    }
  } catch {
    // Fall through to the direct child.
  }
  try {
    child.kill(signal);
  } catch {
    // Already gone.
  }
}

/** Runs the probe and returns the agent's reply text to the usage command. */
export async function runAcpUsageProbe(params: AcpUsageProbeParams): Promise<string> {
  const [command, ...args] = params.argv;
  if (!command) {
    throw new AcpUsageProbeError("The agent has no command", "not-installed");
  }
  params.signal?.throwIfAborted();
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-acp-usage-"));
  let child: ChildProcess | undefined;
  const pending = new Map<number, (message: JsonRpcMessage) => void>();
  let nextId = 0;
  let stderr = "";
  let replyText = "";
  let advertised: Set<string> | undefined;
  let onCommands: (() => void) | undefined;
  let exited: ((error: AcpUsageProbeError) => void) | undefined;
  const exitPromise = new Promise<never>((_resolve, reject) => {
    exited = reject;
  });
  exitPromise.catch(() => {});
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new AcpUsageProbeError(
            `The agent did not answer within ${Math.round(params.timeoutMs / 1000)}s`,
            "timeout",
          ),
        ),
      params.timeoutMs,
    );
  });
  timeout.catch(() => {});
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new AcpUsageProbeError("The usage probe was cancelled", "timeout"));
    params.signal?.addEventListener("abort", onAbort, { once: true });
  });
  aborted.catch(() => {});
  const race = <T>(work: Promise<T>) => Promise.race([work, exitPromise, timeout, aborted]);

  const write = (message: JsonRpcMessage) => {
    child?.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  };
  const request = (method: string, requestParams: Record<string, unknown>) =>
    new Promise<JsonRpcMessage>((resolve) => {
      const id = ++nextId;
      pending.set(id, resolve);
      write({ id, method, params: requestParams });
    });
  const handle = (message: JsonRpcMessage) => {
    if (message.method === undefined && typeof message.id === "number") {
      pending.get(message.id)?.(message);
      pending.delete(message.id);
      return;
    }
    if (message.method === "session/update") {
      const update = (message.params?.update ?? {}) as Record<string, unknown>;
      if (update.sessionUpdate === "agent_message_chunk") {
        const content = update.content as { type?: string; text?: unknown } | undefined;
        if (content?.type === "text" && typeof content.text === "string") {
          replyText += content.text;
        }
      } else if (update.sessionUpdate === "available_commands_update") {
        const commands = Array.isArray(update.availableCommands) ? update.availableCommands : [];
        advertised = new Set(
          commands
            .map((entry) => (entry as { name?: unknown }).name)
            .filter((name): name is string => typeof name === "string")
            .map((name) => name.replace(/^\//, "").toLowerCase()),
        );
        onCommands?.();
      }
      return;
    }
    if (message.method !== undefined && message.id !== undefined) {
      // The probe grants nothing: no permissions, files or terminals.
      if (message.method === "session/request_permission") {
        write({ id: message.id, result: { outcome: { outcome: "cancelled" } } });
      } else {
        write({ id: message.id, error: { code: -32601, message: "Not supported by usage probe" } });
      }
    }
  };

  try {
    child = spawn(command, args, {
      cwd,
      env: params.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      exited?.(
        error.code === "ENOENT"
          ? new AcpUsageProbeError(`Agent command not found: ${command}`, "not-installed")
          : new AcpUsageProbeError(`The agent failed to start: ${error.message}`, "failed"),
      );
    });
    child.on("exit", (code, signal) => {
      const tail = stderr.trim().split(/\r?\n/).at(-1)?.trim();
      exited?.(
        code === 127
          ? new AcpUsageProbeError(`Agent command not found: ${tail || command}`, "not-installed")
          : new AcpUsageProbeError(
              `The agent exited (${signal ?? `code ${code}`})${tail ? `: ${tail}` : ""}`,
              "failed",
            ),
      );
    });
    child.stdin?.on("error", () => {});
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_TAIL_CHARS);
    });
    let buffer = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buffer += chunk;
      for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) {
          continue;
        }
        try {
          handle(JSON.parse(line) as JsonRpcMessage);
        } catch {
          // Agents may log non-JSON lines to stdout; skip them.
        }
      }
    });

    const init = await race(
      request("initialize", {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      }),
    );
    if (init.error) {
      throw new AcpUsageProbeError(
        isAuthError(init.error)
          ? "The agent is not logged in"
          : `The agent failed to start: ${init.error.message ?? "initialize failed"}`,
        isAuthError(init.error) ? "logged-out" : "failed",
      );
    }
    const session = await race(request("session/new", { cwd, mcpServers: [] }));
    const sessionId = (session.result as { sessionId?: unknown } | undefined)?.sessionId;
    if (session.error || typeof sessionId !== "string") {
      throw new AcpUsageProbeError(
        isAuthError(session.error)
          ? "The agent is not logged in"
          : `The agent did not open a session: ${session.error?.message ?? "no session id"}`,
        isAuthError(session.error) ? "logged-out" : "failed",
      );
    }
    try {
      if (!advertised) {
        await race(
          new Promise<void>((resolve) => {
            onCommands = resolve;
            setTimeout(resolve, params.commandsWaitMs ?? 5000).unref?.();
          }),
        );
      }
      const wanted = params.command?.replace(/^\//, "").toLowerCase();
      const usageCommand = wanted
        ? advertised?.has(wanted)
          ? wanted
          : undefined
        : DEFAULT_USAGE_COMMANDS.find((name) => advertised?.has(name));
      if (!usageCommand) {
        throw new AcpUsageProbeError(
          `The agent does not advertise /${wanted ?? DEFAULT_USAGE_COMMANDS.join(" or /")}`,
          "unsupported",
        );
      }
      const prompt = await race(
        request("session/prompt", {
          sessionId,
          prompt: [{ type: "text", text: `/${usageCommand}` }],
        }),
      );
      if (prompt.error) {
        throw new AcpUsageProbeError(
          isAuthError(prompt.error)
            ? "The agent is not logged in"
            : `The agent rejected /${usageCommand}: ${prompt.error.message ?? "error"}`,
          isAuthError(prompt.error) ? "logged-out" : "failed",
        );
      }
      return replyText;
    } finally {
      // Close only the probe's own session; the agent's other sessions are untouched.
      await Promise.race([
        request("session/close", { sessionId }).catch(() => undefined),
        new Promise<void>((resolve) => {
          setTimeout(resolve, CLOSE_WAIT_MS).unref?.();
        }),
        exitPromise.catch(() => undefined),
      ]);
    }
  } finally {
    clearTimeout(timer);
    if (onAbort) {
      params.signal?.removeEventListener("abort", onAbort);
    }
    exited = undefined;
    if (child) {
      child.stdin?.end();
      killTree(child, "SIGTERM");
      const done = child;
      const force = setTimeout(() => killTree(done, "SIGKILL"), KILL_GRACE_MS);
      force.unref?.();
      done.once("exit", () => clearTimeout(force));
    }
    await fs.rm(cwd, { recursive: true, force: true }).catch(() => {});
  }
}
