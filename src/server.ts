import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Config, ProviderName } from "./config.ts";
import { Recorder, type Trace } from "./capture/recorder.ts";
import { log } from "./log.ts";
import { collectChat, streamChat } from "./openai/chat.ts";
import { errorBody, HttpError, type ChatCompletionRequest } from "./openai/types.ts";
import type { ModelEntry, Provider } from "./providers/types.ts";

const MAX_BODY_BYTES = 64 * 1024 * 1024;
const EFFORT_SUFFIX = /^(.+?)[:@](low|medium|high|xhigh|max)$/;

export interface ConduitServer {
  server: Server;
  url: string;
  recorder: Recorder;
  close(): Promise<void>;
}

interface Route {
  provider: Provider;
  upstream: string;
  effort: string | undefined;
}

export async function startServer(
  config: Config,
  providers: Partial<Record<ProviderName, Provider>>,
): Promise<ConduitServer> {
  const recorder = new Recorder(config.capture.enabled ? config.capture.dir : undefined);

  const resolve = (model: string): Route => {
    const suffix = EFFORT_SUFFIX.exec(model);
    const base = suffix ? suffix[1]! : model;
    const effort = suffix ? suffix[2] : undefined;
    const name: ProviderName = base === "mock" ? "mock" : config.defaultProvider;
    return { provider: need(name), upstream: base, effort };
  };

  const need = (name: ProviderName): Provider => {
    const provider = providers[name];
    if (!provider)
      throw new HttpError(
        400,
        `provider "${name}" is not enabled on this server`,
        "model_not_found",
      );
    return provider;
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://conduit");
    let body: unknown;
    let bodyError: unknown;
    try {
      body = req.method === "POST" ? await readJson(req) : undefined;
    } catch (error) {
      bodyError = error;
    }
    const trace = recorder.start(req.method ?? "GET", url.pathname + url.search, req.headers, body);
    const path = url.pathname.replace(/^\/v1(?=\/)/, "");
    log.debug("request", { method: req.method, path: url.pathname });

    try {
      if (bodyError !== undefined) throw bodyError;
      if (req.method === "OPTIONS") return send(res, trace, 204, undefined);
      if (path === "/health" || path === "/")
        return send(res, trace, 200, { status: "ok", name: "conduit" });
      authorize(req, config.server.apiKey);

      if (req.method === "GET" && path === "/models") {
        return send(res, trace, 200, { object: "list", data: await listModels(config, providers) });
      }
      if (req.method === "POST" && path === "/chat/completions") {
        return await chat(req, res, trace, body, resolve, config);
      }
      throw new HttpError(
        404,
        `conduit does not implement ${req.method} ${url.pathname}`,
        "not_found",
      );
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const code = error instanceof HttpError ? error.code : "internal_error";
      const message = error instanceof Error ? error.message : String(error);
      if (status >= 500) log.error("request failed", { path: url.pathname, error: message });
      else
        log.warn("request rejected", { method: req.method, path: url.pathname, status, message });
      if (!res.headersSent) send(res, trace, status, errorBody(message, code));
      else if (!res.writableEnded) res.end();
    }
  };

  const server = createServer((req, res) => {
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-headers", "*");
    res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
    void handle(req, res);
  });
  // Agent turns, and the client's tool runs between them, can be long.
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;

  await new Promise<void>((ok, fail) => {
    server.once("error", fail);
    server.listen(config.server.port, config.server.host, () => ok());
  });
  const address = server.address() as AddressInfo;
  const host = address.family === "IPv6" ? `[${address.address}]` : address.address;

  return {
    server,
    url: `http://${host}:${address.port}`,
    recorder,
    close: async () => {
      await Promise.all(Object.values(providers).map((p) => p?.close()));
      server.closeAllConnections();
      await new Promise<void>((ok) => server.close(() => ok()));
    },
  };
}

async function chat(
  req: IncomingMessage,
  res: ServerResponse,
  trace: Trace,
  body: unknown,
  resolve: (model: string) => Route,
  config: Config,
) {
  const request = validateChat(body);
  const route = resolve(request.model);
  const aborter = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) aborter.abort();
  });

  const effort = request.reasoning_effort ?? route.effort ?? config.claude.effort;
  log.info("chat", {
    model: request.model,
    provider: route.provider.name,
    messages: request.messages.length,
    tools: request.tools?.length ?? 0,
    stream: request.stream === true,
    effort,
  });

  const events = route.provider.turn({
    request,
    upstreamModel: route.upstream,
    effort,
    signal: aborter.signal,
    trace,
  });

  if (request.stream) {
    await streamChat(res, request.model, events, {
      includeUsage: request.stream_options?.include_usage === true,
      reasoning: config.claude.reasoning,
      trace,
    });
  } else {
    const result = await collectChat(request.model, events, config.claude.reasoning);
    send(res, trace, result.status, result.body);
  }
}

function validateChat(body: unknown): ChatCompletionRequest {
  if (typeof body !== "object" || body === null)
    throw new HttpError(400, "request body must be a JSON object");
  const r = body as Partial<ChatCompletionRequest>;
  if (typeof r.model !== "string" || r.model.length === 0)
    throw new HttpError(400, "`model` is required");
  if (!Array.isArray(r.messages) || r.messages.length === 0)
    throw new HttpError(400, "`messages` must be a non-empty array");
  for (const m of r.messages) {
    if (typeof m !== "object" || m === null || typeof (m as { role?: unknown }).role !== "string") {
      throw new HttpError(400, "every message needs a `role`");
    }
    if (m.role === "tool" && typeof (m as { tool_call_id?: unknown }).tool_call_id !== "string") {
      throw new HttpError(400, "tool messages need a `tool_call_id`");
    }
  }
  if (r.tools !== undefined && !Array.isArray(r.tools))
    throw new HttpError(400, "`tools` must be an array");
  return r as ChatCompletionRequest;
}

async function listModels(config: Config, providers: Partial<Record<ProviderName, Provider>>) {
  const created = Math.floor(Date.now() / 1000);
  const seen = new Set<string>();
  const data: Array<Record<string, unknown>> = [];
  const add = (id: string, ownedBy: string, extra: Partial<ModelEntry> = {}) => {
    if (seen.has(id)) return;
    seen.add(id);
    const contextWindow = extra.contextWindow ?? config.claude.contextWindow;
    data.push({
      id,
      object: "model",
      created,
      owned_by: ownedBy,
      ...(extra.displayName ? { display_name: extra.displayName } : {}),
      ...(extra.supportedEfforts ? { supported_reasoning_efforts: extra.supportedEfforts } : {}),
      ...(extra.maxOutputTokens ? { max_output_tokens: extra.maxOutputTokens } : {}),
      ...(contextWindow ? { context_window: contextWindow, context_length: contextWindow } : {}),
    });
  };
  for (const provider of Object.values(providers)) {
    if (!provider) continue;
    for (const m of await provider.listModels()) add(m.id, m.ownedBy, m);
  }
  return data;
}

function authorize(req: IncomingMessage, apiKey: string | undefined) {
  if (apiKey === undefined) return;
  const header = req.headers.authorization;
  const bearer =
    typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : undefined;
  const key =
    bearer ??
    (req.headers["x-api-key"] as string | undefined) ??
    (req.headers["api-key"] as string | undefined);
  if (key !== apiKey) throw new HttpError(401, "invalid API key", "invalid_api_key");
}

function send(res: ServerResponse, trace: Trace, status: number, body: unknown) {
  trace.finish(status, body);
  if (body === undefined) {
    res.writeHead(status).end();
    return;
  }
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "request body too large");
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return { _unparsed: text };
  }
}
