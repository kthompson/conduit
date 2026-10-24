import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const REDACTED_HEADERS = new Set([
  "authorization",
  "x-api-key",
  "api-key",
  "cookie",
  "proxy-authorization",
]);

export interface TraceRecord {
  seq: number;
  startedAt: string;
  durationMs?: number;
  request: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body: unknown;
  };
  response: {
    status?: number;
    /** Parsed SSE `data:` payloads for streaming responses. */
    chunks?: unknown[];
    body?: unknown;
  };
  /** Provider-side events (for Claude: raw Agent SDK messages and conduit notes). */
  upstream: unknown[];
}

/** One HTTP exchange. A disabled trace drops everything. */
export class Trace {
  readonly enabled: boolean;
  readonly record: TraceRecord;
  private readonly file: string | undefined;

  constructor(enabled: boolean, record: TraceRecord, file: string | undefined) {
    this.enabled = enabled;
    this.record = record;
    this.file = file;
  }

  chunk(data: unknown): void {
    if (!this.enabled) return;
    (this.record.response.chunks ??= []).push(data);
  }

  upstream(event: unknown): void {
    if (this.enabled) this.record.upstream.push(event);
  }

  note(message: string, detail?: Record<string, unknown>): void {
    if (this.enabled) this.record.upstream.push({ conduit: message, ...detail });
  }

  finish(status: number, body?: unknown): void {
    if (!this.enabled || this.file === undefined) return;
    this.record.response.status = status;
    if (body !== undefined) this.record.response.body = body;
    this.record.durationMs = Date.now() - Date.parse(this.record.startedAt);
    writeFileSync(this.file, JSON.stringify(this.record, null, 2));
  }
}

export class Recorder {
  readonly dir: string | undefined;
  private seq = 0;

  constructor(baseDir: string | undefined) {
    if (baseDir === undefined) {
      this.dir = undefined;
      return;
    }
    const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
    this.dir = path.join(baseDir, stamp);
    mkdirSync(this.dir, { recursive: true });
  }

  get enabled(): boolean {
    return this.dir !== undefined;
  }

  start(
    method: string,
    url: string,
    headers: Record<string, string | string[] | undefined>,
    body: unknown,
  ): Trace {
    const seq = ++this.seq;
    const record: TraceRecord = {
      seq,
      startedAt: new Date().toISOString(),
      request: { method, url, headers: redactHeaders(headers), body },
      response: {},
      upstream: [],
    };
    if (this.dir === undefined) return new Trace(false, record, undefined);
    const slug =
      url
        .replace(/^\/+/, "")
        .replaceAll(/[^a-zA-Z0-9]+/g, "_")
        .slice(0, 60) || "root";
    const file = path.join(
      this.dir,
      `${String(seq).padStart(4, "0")}-${method.toLowerCase()}-${slug}.json`,
    );
    return new Trace(true, record, file);
  }
}

function redactHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const joined = Array.isArray(value) ? value.join(", ") : value;
    out[key] = REDACTED_HEADERS.has(key.toLowerCase())
      ? `<redacted ${joined.length} chars>`
      : joined;
  }
  return out;
}
