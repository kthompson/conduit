import { query, type ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeConfig } from "../../config.ts";
import { Trace, type TraceRecord } from "../../capture/recorder.ts";
import { log } from "../../log.ts";
import { textOf, type ChatMessage } from "../../openai/types.ts";
import type { ModelEntry, Provider, TurnEvent, TurnInput } from "../types.ts";
import {
  fingerprint,
  renderTranscript,
  sessionKey,
  splitSystem,
  toToolResultContent,
  toUserBlocks,
  TRANSCRIPT_PREAMBLE,
  type ToolResultContent,
  type UserBlock,
} from "./conversation.ts";
import { knownLimits } from "./limits.ts";
import { ClaudeSession } from "./session.ts";

const MODEL_CACHE_MS = 10 * 60 * 1000;
const FALLBACK_MODELS = ["opus", "sonnet", "haiku"];

/** The parts of a live session that decide whether a request continues it. */
export interface SessionLike {
  key: string;
  state: ClaudeSession["state"];
  lastUsed: number;
  transcript: readonly string[];
  pendingToolIds: readonly string[];
}

export type Match<S> =
  | { kind: "tools"; session: S; results: Array<{ id: string; content: ToolResultContent[] }> }
  | { kind: "user"; session: S; blocks: UserBlock[] }
  | { kind: "none" };

export class ClaudeProvider implements Provider {
  readonly name = "claude";
  private readonly config: ClaudeConfig;
  private readonly sessions = new Set<ClaudeSession>();
  private readonly reaper: NodeJS.Timeout;
  private readonly limits = new Map<string, { contextWindow: number; maxOutputTokens: number }>();
  private models: { at: number; list: ModelInfo[] } | undefined;

  constructor(config: ClaudeConfig) {
    this.config = config;
    this.reaper = setInterval(() => this.reapIdle(), 30_000);
    this.reaper.unref();
  }

  /** Matches usage keys like "claude-opus-4-5-20251101" or "claude-opus-4-5[1m]" to the ids we list. */
  recordLimits(model: string, limits: { contextWindow: number; maxOutputTokens: number }): void {
    this.limits.set(model, limits);
    this.limits.set(model.replace(/\[.*\]$/, ""), limits);
  }

  async listModels(): Promise<ModelEntry[]> {
    const infos = await this.supportedModels();
    const seen = new Set<string>();
    const out: ModelEntry[] = [];
    for (const info of infos) {
      if (info.value === "default") continue;
      const id = info.resolvedModel ?? info.value;
      if (seen.has(id)) continue;
      seen.add(id);
      const learned = this.limits.get(id) ?? this.limits.get(info.value) ?? knownLimits(id);
      out.push({
        id,
        ...(learned ?? {}),
        ownedBy: "anthropic",
        displayName: info.displayName,
        ...(info.supportsEffort && info.supportedEffortLevels
          ? { supportedEfforts: info.supportedEffortLevels }
          : {}),
      });
    }
    return out;
  }

  /** Runs one tiny turn so Claude Code reports this model's real limits; they then show up in listModels(). */
  async probe(model: string): Promise<boolean> {
    const trace = new Trace(false, {} as TraceRecord, undefined);
    const request = {
      model,
      messages: [{ role: "user" as const, content: "Reply with the single word: ok" }],
    };
    let failed = false;
    for await (const event of this.turn({
      request,
      upstreamModel: model,
      effort: undefined,
      signal: AbortSignal.timeout(90_000),
      trace,
    })) {
      if (event.type === "error") failed = true;
    }
    return !failed;
  }

  async *turn(input: TurnInput): AsyncIterable<TurnEvent> {
    const { request } = input;
    const { system, conversation } = splitSystem(request.messages);
    const tools = (request.tools ?? []).filter((t) => t.type === "function");
    const key = sessionKey({ system, tools, model: input.upstreamModel, effort: input.effort });
    const prints = conversation.map(fingerprint);

    // Matching and starting the turn happen with no await in between, so two
    // concurrent requests can never claim the same session.
    const match = matchSession(this.sessions, key, conversation, prints);
    let events: AsyncIterable<TurnEvent>;
    if (match.kind === "tools") {
      input.trace.note("matched live session awaiting tool results", { session: match.session.id });
      events = match.session.sendToolResults(
        match.results,
        prints.slice(match.session.transcript.length),
        input.trace,
        input.signal,
      );
    } else if (match.kind === "user") {
      input.trace.note("matched idle live session", { session: match.session.id });
      events = match.session.sendUser(
        match.blocks,
        prints.slice(match.session.transcript.length),
        input.trace,
        input.signal,
      );
    } else {
      this.evictForNewSession();
      const session = new ClaudeSession(
        {
          key,
          model: input.upstreamModel,
          effort: input.effort,
          system,
          tools,
          config: this.config,
          onLimits: (m, l) => this.recordLimits(m, l),
        },
        (s) => this.sessions.delete(s),
      );
      this.sessions.add(session);
      const blocks = coldStartBlocks(conversation);
      input.trace.note("started new claude session", {
        session: session.id,
        historyMessages: conversation.length,
        liveSessions: this.sessions.size,
      });
      log.info("new claude session", {
        session: session.id,
        model: input.upstreamModel,
        history: conversation.length,
      });
      events = session.sendUser(blocks, prints, input.trace, input.signal);
    }
    yield* events;
  }

  async close(): Promise<void> {
    clearInterval(this.reaper);
    for (const s of [...this.sessions]) s.close("server shutting down");
  }

  private evictForNewSession(): void {
    if (this.sessions.size < this.config.maxSessions) return;
    const idle = [...this.sessions]
      .filter((s) => s.state !== "busy")
      .sort((a, b) => a.lastUsed - b.lastUsed);
    const oldest = idle[0];
    if (oldest) oldest.close("evicted for a new session");
    else
      log.warn("all claude sessions are busy; exceeding max_sessions", {
        max: this.config.maxSessions,
      });
  }

  private reapIdle(): void {
    const cutoff = Date.now() - this.config.sessionIdleSeconds * 1000;
    for (const s of [...this.sessions]) {
      if (s.state !== "busy" && s.lastUsed < cutoff) s.close("idle timeout");
    }
  }

  private async supportedModels(): Promise<ModelInfo[]> {
    if (this.models && Date.now() - this.models.at < MODEL_CACHE_MS) return this.models.list;
    try {
      const list = await probeModels(this.config);
      this.models = { at: Date.now(), list };
      return list;
    } catch (error) {
      log.warn("could not list Claude models; using aliases", { error: String(error) });
      return FALLBACK_MODELS.map((value) => ({ value, displayName: value, description: "" }));
    }
  }
}

/**
 * Finds the live session a request continues: its history must extend what
 * the session has seen, followed either by results for the session's pending
 * tool calls or by new user content.
 */
export function matchSession<S extends SessionLike>(
  sessions: Iterable<S>,
  key: string,
  conversation: ChatMessage[],
  prints: string[],
): Match<S> {
  const candidates = [...sessions]
    .filter((s) => s.key === key && (s.state === "idle" || s.state === "awaiting_tools"))
    .sort((a, b) => b.lastUsed - a.lastUsed);

  for (const session of candidates) {
    const seen = session.transcript;
    if (prints.length <= seen.length) continue;
    if (!seen.every((p, i) => p === prints[i])) continue;
    const rest = conversation.slice(seen.length);

    if (session.state === "awaiting_tools") {
      const results: Array<{ id: string; content: ToolResultContent[] }> = [];
      let i = 0;
      for (; i < rest.length && rest[i]!.role === "tool"; i++) {
        const m = rest[i] as Extract<ChatMessage, { role: "tool" }>;
        results.push({ id: m.tool_call_id, content: toToolResultContent(m.content) });
      }
      if (results.length === 0) continue;
      if (!results.every((r) => session.pendingToolIds.includes(r.id))) continue;
      const after = rest.slice(i);
      if (!after.every(isUserLike)) continue;
      // Content the client adds after tool results rides along with the last result.
      const extra = after.flatMap(userLikeBlocks).map(blockToResult);
      if (extra.length > 0) results.at(-1)!.content.push(...extra);
      return { kind: "tools", session, results };
    }

    if (rest.every(isUserLike)) {
      return { kind: "user", session, blocks: rest.flatMap(userLikeBlocks) };
    }
  }
  return { kind: "none" };
}

/** Asks a short-lived Claude Code process which models this login can use. */
export async function probeModels(config: ClaudeConfig): Promise<ModelInfo[]> {
  const q = openProbe(config);
  try {
    return await q.supportedModels();
  } finally {
    q.close();
  }
}

export function openProbe(config: ClaudeConfig) {
  const env: Record<string, string | undefined> = { ...process.env, ...config.env };
  if (config.stripApiKey) delete env.ANTHROPIC_API_KEY;
  return query({
    prompt: (async function* () {})(),
    options: {
      tools: [],
      settingSources: [],
      persistSession: false,
      cwd: config.cwd,
      env,
      ...(config.binary === undefined ? {} : { pathToClaudeCodeExecutable: config.binary }),
    },
  });
}

function isUserLike(m: ChatMessage): boolean {
  return m.role === "user" || m.role === "system" || m.role === "developer";
}

function userLikeBlocks(m: ChatMessage): UserBlock[] {
  if (m.role === "user") return toUserBlocks(m.content);
  return [{ type: "text", text: `[system]\n${textOf(m.content)}` }];
}

function blockToResult(block: UserBlock): ToolResultContent {
  if (block.type === "text") return block;
  if (block.source.type === "base64")
    return { type: "image", data: block.source.data, mimeType: block.source.media_type };
  return { type: "text", text: `[image: ${block.source.url}]` };
}

/**
 * The first message of a new session: earlier history as a transcript,
 * followed by the trailing user message(s) as real content.
 */
export function coldStartBlocks(conversation: ChatMessage[]): UserBlock[] {
  let tail = conversation.length;
  while (tail > 0 && isUserLike(conversation[tail - 1]!)) tail--;
  const history = conversation.slice(0, tail);
  const latest = conversation.slice(tail);

  const blocks: UserBlock[] = [];
  if (history.length > 0) {
    blocks.push({
      type: "text",
      text: `${TRANSCRIPT_PREAMBLE}\n\n<transcript>\n${renderTranscript(history)}\n</transcript>`,
    });
  }
  if (latest.length > 0) {
    blocks.push(...latest.flatMap(userLikeBlocks));
  } else if (history.at(-1)?.role === "tool") {
    blocks.push({
      type: "text",
      text: "The latest tool results are at the end of the transcript. Continue.",
    });
  } else {
    blocks.push({ type: "text", text: "Continue." });
  }
  return blocks;
}
