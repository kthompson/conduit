import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import type { CodexConfig } from "../../config.ts";
import { log } from "../../log.ts";
import { scratchCodexHome } from "./home.ts";

type Json = unknown;

/** A JSON-RPC error answered by `codex app-server`. */
export class RpcError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

export interface AppServerHandlers {
  /** A notification (no id, no reply expected). */
  onNotification(method: string, params: Json): void;
  /** A request from the server. Resolve with its result; reject with `RpcError` to answer with an error. */
  onRequest(method: string, params: Json): Promise<Json>;
  /** The process ended. Called once. */
  onExit(reason: string): void;
}

/** The environment for a Codex process: configured env on top of ours, minus the API key when asked. */
export function codexEnv(config: CodexConfig): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, ...config.env };
  if (config.stripApiKey) {
    delete env.OPENAI_API_KEY;
    delete env.CODEX_API_KEY;
  }
  return env;
}

/**
 * A JSON-RPC 2.0 client over the stdio of a `codex app-server` process. Codex
 * omits the `jsonrpc` field on what it sends and accepts it on what it
 * receives, so messages are matched on `id` and `method` alone.
 */
export class AppServerClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly handlers: AppServerHandlers;
  private readonly pending = new Map<
    number,
    { resolve: (value: Json) => void; reject: (error: Error) => void }
  >();
  private nextId = 1;
  private exited: string | undefined;

  private constructor(child: ChildProcessWithoutNullStreams, handlers: AppServerHandlers) {
    this.child = child;
    this.handlers = handlers;
    readline.createInterface({ input: child.stdout }).on("line", (line) => this.receive(line));
    readline
      .createInterface({ input: child.stderr })
      .on("line", (data) => log.debug("codex stderr", { data }));
    // A process that cannot be started (no such binary) reports here, not as an exit code.
    child.once("error", (error) => this.end(`could not run codex: ${error.message}`));
    child.once("exit", (code, signal) =>
      this.end(
        `codex exited${signal ? ` (${signal})` : code === null ? "" : ` with code ${code}`}`,
      ),
    );
    child.stdin.on("error", () => {});
  }

  /** Starts `codex app-server` and completes the initialize handshake. */
  static async start(
    config: CodexConfig,
    env: Record<string, string | undefined>,
    handlers: AppServerHandlers,
  ): Promise<AppServerClient> {
    const child = spawn(config.binary ?? "codex", ["app-server"], {
      cwd: config.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const client = new AppServerClient(child, handlers);
    try {
      await client.request("initialize", {
        clientInfo: { name: "conduit", title: "conduit", version: "0.1.0" },
        capabilities: { experimentalApi: true, requestAttestation: false },
      });
      client.notify("initialized");
    } catch (error) {
      client.close();
      throw error;
    }
    return client;
  }

  request<T = Json>(method: string, params?: Json): Promise<T> {
    if (this.exited !== undefined) return Promise.reject(new Error(this.exited));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: Json) => void, reject });
      this.write({ id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  notify(method: string, params?: Json): void {
    this.write({ method, ...(params === undefined ? {} : { params }) });
  }

  /** Stops the process. Idempotent. */
  close(): void {
    this.end("codex was closed");
    if (this.child.exitCode === null && !this.child.killed) this.child.kill();
  }

  private write(message: Record<string, Json>): void {
    if (this.exited !== undefined) return;
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
  }

  private receive(line: string): void {
    let message: Record<string, Json>;
    try {
      message = JSON.parse(line) as Record<string, Json>;
    } catch {
      log.debug("codex sent a line that is not JSON", { line: line.slice(0, 200) });
      return;
    }
    const { id, method } = message;
    if (typeof method === "string") {
      if (id === undefined) return this.handlers.onNotification(method, message.params);
      void this.answer(id, method, message.params);
      return;
    }
    if (typeof id !== "number") return;
    const waiter = this.pending.get(id);
    if (!waiter) return;
    this.pending.delete(id);
    const error = message.error as { code?: number; message?: string } | undefined;
    if (error) waiter.reject(new RpcError(error.code ?? -32000, error.message ?? "request failed"));
    else waiter.resolve(message.result);
  }

  private async answer(id: Json, method: string, params: Json): Promise<void> {
    try {
      this.write({ id, result: await this.handlers.onRequest(method, params) });
    } catch (error) {
      const code = error instanceof RpcError ? error.code : -32603;
      const text = error instanceof Error ? error.message : String(error);
      this.write({ id, error: { code, message: text } });
    }
  }

  private end(reason: string): void {
    if (this.exited !== undefined) return;
    this.exited = reason;
    for (const waiter of this.pending.values()) waiter.reject(new Error(reason));
    this.pending.clear();
    this.handlers.onExit(reason);
  }
}

/** Codex under a scratch CODEX_HOME. `dispose` stops it and removes the home. */
export async function launchCodex(
  config: CodexConfig,
  handlers: AppServerHandlers,
): Promise<{ client: AppServerClient; dispose: () => void }> {
  const home = scratchCodexHome(config.env.CODEX_HOME);
  try {
    const client = await AppServerClient.start(
      config,
      { ...codexEnv(config), CODEX_HOME: home.dir },
      handlers,
    );
    return {
      client,
      dispose: () => {
        client.close();
        home.remove();
      },
    };
  } catch (error) {
    home.remove();
    throw error;
  }
}

const READ_TIMEOUT_MS = 30_000;

/** Runs one short query against a throwaway Codex process, with a deadline. */
export async function queryCodex<T>(
  config: CodexConfig,
  run: (client: AppServerClient) => Promise<T>,
): Promise<T> {
  let stop: (() => void) | undefined;
  const timer = setTimeout(() => stop?.(), READ_TIMEOUT_MS);
  try {
    const { client, dispose } = await launchCodex(config, {
      onNotification: () => {},
      onRequest: () => Promise.reject(new RpcError(-32601, "conduit does not handle requests")),
      onExit: () => {},
    });
    stop = dispose;
    try {
      return await run(client);
    } finally {
      dispose();
    }
  } finally {
    clearTimeout(timer);
  }
}
