import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeConfig } from "../../config.ts";
import { Trace, type TraceRecord } from "../../capture/recorder.ts";
import { log } from "../../log.ts";
import { textOf, type ChatMessage } from "../../openai/types.ts";
import type { ProviderRegistry } from "../registry.ts";
import type { ModelEntry, Provider, TurnEvent, TurnInput } from "../types.ts";
import {
  fingerprint,
  sessionKey,
  splitSystem,
  toToolResultContent,
  toUserBlocks,
  type ToolResultContent,
  type UserBlock,
} from "./conversation.ts";
import { knownLimits } from "./limits.ts";
import { probeModels } from "./probe.ts";
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
  private readonly registry: ProviderRegistry | undefined;
  private readonly sessions = new Set<ClaudeSession>();
  private readonly reaper: NodeJS.Timeout;
  private readonly limits = new Map<string, { contextWindow: number; maxOutputTokens: number }>();
  private models: { at: number; list: ModelInfo[] } | undefined;

  /** With a registry, new conversations are routed across its providers by priority. */
  constructor(config: ClaudeConfig, registry?: ProviderRegistry) {
    this.config = config;
    this.registry = registry;
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
        ...learned,
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
    const failed = new Set<string>();
    for (;;) {
      let started: ReturnType<ClaudeProvider["startTurn"]>;
      try {
        started = this.startTurn(input, failed);
      } catch (error) {
        yield { type: "error", message: error instanceof Error ? error.message : String(error) };
        return;
      }
      const { providerId, events } = started;
      const iterator = events[Symbol.asyncIterator]();
      let current = await iterator.next();
      const first = current.done ? undefined : current.value;
      if (first?.type === "error" && first.failure && this.registry) {
        // Nothing has reached the client yet, so another provider can take over.
        const { kind, resetsAt } = first.failure;
        this.registry.markFailed(providerId, kind, first.message, resetsAt);
        failed.add(providerId);
        if (this.registry.pick(failed)) {
          log.info("retrying on the next provider", { failed: providerId, reason: kind });
          continue;
        }
      }
      while (!current.done) {
        if (current.value.type === "done") this.recordUsage(providerId, current.value);
        yield current.value;
        current = await iterator.next();
      }
      return;
    }
  }

  private recordUsage(providerId: string, done: Extract<TurnEvent, { type: "done" }>): void {
    const u = done.usage;
    this.registry?.recordTurn(
      providerId,
      u
        ? {
            prompt: u.prompt_tokens,
            completion: u.completion_tokens,
            cached: u.prompt_tokens_details?.cached_tokens ?? 0,
          }
        : undefined,
    );
  }

  /**
   * Finds or starts the session for a request. Matching and starting happen with
   * no await in between, so two concurrent requests can never claim the same session.
   */
  private startTurn(
    input: TurnInput,
    failed: ReadonlySet<string>,
  ): { providerId: string; events: AsyncIterable<TurnEvent> } {
    const { request } = input;
    const { system, conversation } = splitSystem(request.messages);
    const tools = (request.tools ?? []).filter((t) => t.type === "function");
    const key = sessionKey({ system, tools, model: input.upstreamModel, effort: input.effort });
    const prints = conversation.map(fingerprint);

    const usable = [...this.sessions].filter(
      (s) => !failed.has(s.providerId) && this.registry?.store.get(s.providerId)?.enabled !== false,
    );
    const match = matchSession(usable, key, conversation, prints);
    if (match.kind === "tools") {
      input.trace.note("matched live session awaiting tool results", { session: match.session.id });
      return {
        providerId: match.session.providerId,
        events: match.session.sendToolResults(
          match.results,
          prints.slice(match.session.transcript.length),
          input.trace,
          input.signal,
        ),
      };
    }
    if (match.kind === "user") {
      input.trace.note("matched idle live session", { session: match.session.id });
      return {
        providerId: match.session.providerId,
        events: match.session.sendUser(
          match.blocks,
          prints.slice(match.session.transcript.length),
          input.trace,
          input.signal,
        ),
      };
    }

    const chosen = this.registry ? this.registry.pick(failed) : undefined;
    if (this.registry && !chosen) {
      throw new Error("No provider is available: every provider is disabled or logged out.");
    }
    const providerId = chosen?.id ?? "default";
    const config = chosen && this.registry ? this.registry.claudeConfig(chosen) : this.config;
    this.evictForNewSession();
    const { history, blocks } = coldStart(conversation);
    const session = new ClaudeSession(
      {
        key,
        providerId,
        model: input.upstreamModel,
        effort: input.effort,
        system,
        tools,
        history,
        config,
        onLimits: (m, l) => this.recordLimits(m, l),
      },
      (s) => this.sessions.delete(s),
    );
    this.sessions.add(session);
    input.trace.note("started new claude session", {
      session: session.id,
      provider: providerId,
      historyMessages: conversation.length,
      liveSessions: this.sessions.size,
    });
    log.info("new claude session", {
      session: session.id,
      provider: providerId,
      model: input.upstreamModel,
      history: conversation.length,
    });
    return { providerId, events: session.sendUser(blocks, prints, input.trace, input.signal) };
  }

  async close(): Promise<void> {
    clearInterval(this.reaper);
    for (const s of this.sessions) s.close("server shutting down");
  }

  /** Models come from the highest-priority enabled login. */
  private modelsConfig(): ClaudeConfig {
    const first = this.registry?.store.enabled()[0];
    return first && this.registry ? this.registry.claudeConfig(first) : this.config;
  }

  private evictForNewSession(): void {
    if (this.sessions.size < this.config.maxSessions) return;
    const idle = [...this.sessions]
      .filter((s) => s.state !== "busy")
      .toSorted((a, b) => a.lastUsed - b.lastUsed);
    const oldest = idle[0];
    if (oldest) oldest.close("evicted for a new session");
    else {
      log.warn("all claude sessions are busy; exceeding max_sessions", {
        max: this.config.maxSessions,
      });
    }
  }

  private reapIdle(): void {
    const cutoff = Date.now() - this.config.sessionIdleSeconds * 1000;
    for (const s of this.sessions) {
      if (s.state !== "busy" && s.lastUsed < cutoff) s.close("idle timeout");
    }
  }

  private async supportedModels(): Promise<ModelInfo[]> {
    if (this.models && Date.now() - this.models.at < MODEL_CACHE_MS) return this.models.list;
    try {
      const list = await probeModels(this.modelsConfig());
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
    .toSorted((a, b) => b.lastUsed - a.lastUsed);

  for (const session of candidates) {
    const seen = session.transcript;
    if (prints.length <= seen.length) continue;
    if (!seen.every((p, i) => p === prints[i])) continue;
    const rest = conversation.slice(seen.length);

    if (session.state === "awaiting_tools") {
      const results: Array<{ id: string; content: ToolResultContent[] }> = [];
      let i = 0;
      for (const m of rest) {
        if (m.role !== "tool") break;
        i++;
        results.push({ id: m.tool_call_id, content: toToolResultContent(m.content) });
      }
      if (results.length === 0) continue;
      if (!results.every((r) => session.pendingToolIds.includes(r.id))) continue;
      const after = rest.slice(i);
      if (!after.every(isUserLike)) continue;
      // Content the client adds after tool results rides along with the last result.
      const extra = after.flatMap(userLikeBlocks).map(blockToResult);
      results.at(-1)?.content.push(...extra);
      return { kind: "tools", session, results };
    }

    if (rest.every(isUserLike)) {
      return { kind: "user", session, blocks: rest.flatMap(userLikeBlocks) };
    }
  }
  return { kind: "none" };
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
  if (block.source.type === "base64") {
    return { type: "image", data: block.source.data, mimeType: block.source.media_type };
  }
  return { type: "text", text: `[image: ${block.source.url}]` };
}

/**
 * Splits a new session's request into the history to resume as real turns and
 * the trailing user message(s) that start the first turn.
 */
export function coldStart(conversation: ChatMessage[]): {
  history: ChatMessage[];
  blocks: UserBlock[];
} {
  let tail = conversation.length;
  while (tail > 0 && isUserLike(conversation.at(tail - 1) as ChatMessage)) tail--;
  const history = conversation.slice(0, tail);
  const latest = conversation.slice(tail);
  const blocks = latest.flatMap(userLikeBlocks);
  if (blocks.length === 0) blocks.push({ type: "text", text: "Continue." });
  return { history, blocks };
}
