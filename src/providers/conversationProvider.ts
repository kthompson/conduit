import type { AgentConfig } from "../config.ts";
import { log } from "../log.ts";
import type { ChatMessage, FunctionTool } from "../openai/types.ts";
import { fingerprint, sessionKey, splitSystem } from "./conversation.ts";
import { coldStart, matchSession } from "./matching.ts";
import type { ProviderRegistry } from "./registry.ts";
import type { BaseSession } from "./session.ts";
import type { ProviderEntry, ProviderType } from "./store.ts";
import type { ModelEntry, Provider, ProviderSettings, TurnEvent, TurnInput } from "./types.ts";

export interface NewSessionArgs<S> {
  key: string;
  providerId: string;
  /** The configured login to run under; undefined when there is no registry. */
  entry: ProviderEntry | undefined;
  model: string;
  effort: string | undefined;
  system: string;
  tools: FunctionTool[];
  /** Earlier conversation to resume as real turns; empty for a fresh conversation. */
  history: ChatMessage[];
  onClose: (session: S) => void;
}

/**
 * A provider that keeps one live agent process per conversation. It decides
 * whether a request continues a live session or starts a new one, picks which
 * configured login serves a new conversation, retries on the next login when
 * the first is rate limited or logged out, and bounds the number of processes.
 * Subclasses supply the agent: how to create a session and which models exist.
 */
export abstract class ConversationProvider<S extends BaseSession> implements Provider {
  abstract readonly name: string;
  abstract readonly settings: ProviderSettings;
  protected abstract readonly type: ProviderType;
  protected abstract readonly agent: AgentConfig;
  protected readonly registry: ProviderRegistry | undefined;
  protected readonly sessions = new Set<S>();
  private readonly reaper: NodeJS.Timeout;

  /** With a registry, new conversations are routed across its logins by priority. */
  constructor(registry?: ProviderRegistry) {
    this.registry = registry;
    this.reaper = setInterval(() => this.reapIdle(), 30_000);
    this.reaper.unref();
  }

  abstract listModels(): Promise<ModelEntry[]>;
  /** Whether this provider serves `model`, judged from its id alone. */
  abstract owns(model: string): boolean;
  protected abstract createSession(args: NewSessionArgs<S>): S;

  async *turn(input: TurnInput): AsyncIterable<TurnEvent> {
    const failed = new Set<string>();
    for (;;) {
      let started: ReturnType<ConversationProvider<S>["startTurn"]>;
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
        // Nothing has reached the client yet, so another login can take over.
        const { kind, resetsAt } = first.failure;
        this.registry.markFailed(providerId, kind, first.message, resetsAt);
        failed.add(providerId);
        if (this.registry.pick(failed, this.type)) {
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

  async close(): Promise<void> {
    clearInterval(this.reaper);
    for (const s of this.sessions) s.close("server shutting down");
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

    const chosen = this.registry ? this.registry.pick(failed, this.type) : undefined;
    if (this.registry && !chosen) {
      throw new Error(
        this.registry.store.enabled(this.type).length === 0
          ? `No ${this.name} login is configured. Add one in the web UI (Providers, Add provider).`
          : `No ${this.name} login is available: every one is disabled, rate limited out or logged out.`,
      );
    }
    const providerId = chosen?.id ?? "default";
    this.evictForNewSession();
    const { history, blocks } = coldStart(conversation);
    const session = this.createSession({
      key,
      providerId,
      entry: chosen,
      model: input.upstreamModel,
      effort: input.effort,
      system,
      tools,
      history,
      onClose: (s) => this.sessions.delete(s),
    });
    this.sessions.add(session);
    input.trace.note(`started new ${this.name} session`, {
      session: session.id,
      provider: providerId,
      historyMessages: conversation.length,
      liveSessions: this.sessions.size,
    });
    log.info(`new ${this.name} session`, {
      session: session.id,
      provider: providerId,
      model: input.upstreamModel,
      history: conversation.length,
    });
    return { providerId, events: session.sendUser(blocks, prints, input.trace, input.signal) };
  }

  private evictForNewSession(): void {
    if (this.sessions.size < this.agent.maxSessions) return;
    const idle = [...this.sessions]
      .filter((s) => s.state !== "busy")
      .toSorted((a, b) => a.lastUsed - b.lastUsed);
    const oldest = idle[0];
    if (oldest) oldest.close("evicted for a new session");
    else {
      log.warn(`all ${this.name} sessions are busy; exceeding max_sessions`, {
        max: this.agent.maxSessions,
      });
    }
  }

  private reapIdle(): void {
    const cutoff = Date.now() - this.agent.sessionIdleSeconds * 1000;
    for (const s of this.sessions) {
      if (s.state !== "busy" && s.lastUsed < cutoff) s.close("idle timeout");
    }
  }
}
