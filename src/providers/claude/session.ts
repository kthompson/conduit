import { randomUUID } from "node:crypto";
import {
  query,
  type EffortLevel,
  type Options,
  type Query,
  type SDKMessage,
  type SDKPartialAssistantMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { Channel } from "../../channel.ts";
import type { ClaudeConfig } from "../../config.ts";
import type { Trace } from "../../capture/recorder.ts";
import type { FinishReason, FunctionTool, Usage } from "../../openai/types.ts";
import { log } from "../../log.ts";
import type { TurnEvent } from "../types.ts";
import { assistantFingerprint, type ToolResultContent, type UserBlock } from "./conversation.ts";
import { BRIDGE_SERVER, ToolBridge } from "./toolBridge.ts";

const DEFAULT_SYSTEM_PROMPT = "You are a helpful assistant.";
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

export type SessionState = "busy" | "awaiting_tools" | "idle" | "closed";

export interface SessionOptions {
  key: string;
  model: string;
  effort: string | undefined;
  system: string;
  tools: FunctionTool[];
  config: ClaudeConfig;
  /** Receives the real context window and output cap Claude Code reports after a turn. */
  onLimits?: (model: string, limits: { contextWindow: number; maxOutputTokens: number }) => void;
}

interface ActiveTurn {
  events: Channel<TurnEvent>;
  trace: Trace;
  /** Fingerprints of the request messages this turn answers; committed when it finishes. */
  incoming: string[];
  text: string;
  toolCalls: Array<{ id: string; name: string }>;
  blockToTool: Map<number, number>;
  stopReason: string | null;
  usage: { input: number; cacheRead: number; cacheWrite: number; output: number };
  streamed: boolean;
}

/**
 * One live Claude Code process holding one conversation. Turns arrive as
 * separate HTTP requests; the process and its prompt cache stay warm between
 * them, including across a client-side tool round trip.
 */
export class ClaudeSession {
  readonly id = randomUUID().slice(0, 8);
  readonly key: string;
  readonly model: string;
  state: SessionState = "idle";
  lastUsed = Date.now();
  /** Fingerprints of every conversation message Claude has seen, in order. */
  readonly transcript: string[] = [];
  /** Tool calls from the last turn that the client still has to answer. */
  pendingToolIds: string[] = [];

  private readonly input = new Channel<SDKUserMessage>();
  private readonly bridge: ToolBridge;
  private readonly query: Query;
  private turn: ActiveTurn | undefined;
  /** The finished turn's `result` message is still to come and belongs to no turn. */
  private awaitingResult = false;
  private readonly onClose: (session: ClaudeSession) => void;

  private readonly onLimits: SessionOptions["onLimits"];

  constructor(options: SessionOptions, onClose: (session: ClaudeSession) => void) {
    this.key = options.key;
    this.model = options.model;
    this.onClose = onClose;
    this.onLimits = options.onLimits;
    this.bridge = new ToolBridge(options.tools);
    this.query = query({ prompt: this.input, options: buildOptions(options, this.bridge) });
    void this.pump();
  }

  /** Starts a turn from new user content. */
  sendUser(
    blocks: UserBlock[],
    incoming: string[],
    trace: Trace,
    signal: AbortSignal,
  ): AsyncIterable<TurnEvent> {
    const events = this.begin(incoming, trace, signal);
    this.input.push({
      type: "user",
      // Media types are the client's claim; the API rejects ones it does not support.
      message: { role: "user", content: blocks as SDKUserMessage["message"]["content"] },
      parent_tool_use_id: null,
    });
    return events;
  }

  /** Resumes a turn that stopped for tool calls by handing Claude the client's results. */
  sendToolResults(
    results: Array<{ id: string; content: ToolResultContent[] }>,
    incoming: string[],
    trace: Trace,
    signal: AbortSignal,
  ): AsyncIterable<TurnEvent> {
    const events = this.begin(incoming, trace, signal);
    const answered = new Set(results.map((r) => r.id));
    for (const r of results) this.bridge.deliver(r.id, r.content);
    for (const id of this.pendingToolIds) {
      if (!answered.has(id)) {
        this.bridge.deliver(id, [
          { type: "text", text: "The client did not return a result for this tool call." },
        ]);
      }
    }
    this.pendingToolIds = [];
    return events;
  }

  close(reason: string): void {
    if (this.state === "closed") return;
    this.state = "closed";
    log.debug("claude session closed", { session: this.id, reason });
    this.bridge.cancelAll(`Session closed: ${reason}`);
    if (this.turn) this.endTurn({ type: "error", message: `Claude session closed: ${reason}` });
    this.input.end();
    this.query.close();
    this.onClose(this);
  }

  private begin(incoming: string[], trace: Trace, signal: AbortSignal): AsyncIterable<TurnEvent> {
    if (this.turn) throw new Error("session already has an active turn");
    this.state = "busy";
    this.lastUsed = Date.now();
    const events = new Channel<TurnEvent>();
    this.turn = {
      events,
      trace,
      incoming,
      text: "",
      toolCalls: [],
      blockToTool: new Map(),
      stopReason: null,
      usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
      streamed: false,
    };
    trace.note("claude session", {
      session: this.id,
      model: this.model,
      transcriptLength: this.transcript.length,
    });
    signal.addEventListener(
      "abort",
      () => {
        // The client's history no longer matches Claude's, so the process cannot be reused.
        if (this.turn?.events === events) this.close("client disconnected mid-turn");
      },
      { once: true },
    );
    return events;
  }

  private async pump(): Promise<void> {
    try {
      for await (const message of this.query) this.handle(message);
      this.close("Claude Code exited");
    } catch (error) {
      log.error("claude session failed", { session: this.id, error: String(error) });
      this.close(error instanceof Error ? error.message : String(error));
    }
  }

  private handle(message: SDKMessage): void {
    this.turn?.trace.upstream(message);
    switch (message.type) {
      case "stream_event":
        if (message.parent_tool_use_id === null) this.handleStream(message.event);
        return;
      case "result":
        return this.handleResult(message);
      case "system":
        if (message.subtype === "init") {
          log.debug("claude session ready", {
            session: this.id,
            model: message.model,
            tools: message.tools.length,
          });
        }
        return;
      default:
        return;
    }
  }

  private handleStream(event: StreamEvent): void {
    const turn = this.turn;
    if (!turn) {
      log.debug("claude stream event outside a turn", { session: this.id, event: event.type });
      return;
    }
    switch (event.type) {
      case "message_start": {
        const u = event.message.usage;
        turn.usage.input += u.input_tokens ?? 0;
        turn.usage.cacheRead += u.cache_read_input_tokens ?? 0;
        turn.usage.cacheWrite += u.cache_creation_input_tokens ?? 0;
        turn.blockToTool.clear();
        turn.stopReason = null;
        return;
      }
      case "content_block_start": {
        const block = event.content_block;
        if (block.type !== "tool_use") return;
        const name = this.bridge.clientName(block.name);
        // A tool the client does not know is Claude Code's own business; it answers it and continues.
        if (name === undefined) return;
        const index = turn.toolCalls.length;
        turn.toolCalls.push({ id: block.id, name });
        turn.blockToTool.set(event.index, index);
        this.emit({ type: "tool_call_start", index, id: block.id, name });
        return;
      }
      case "content_block_delta": {
        const delta = event.delta;
        if (delta.type === "text_delta") {
          turn.text += delta.text;
          this.emit({ type: "text", delta: delta.text });
        } else if (delta.type === "thinking_delta") {
          this.emit({ type: "reasoning", delta: delta.thinking });
        } else if (delta.type === "input_json_delta") {
          const index = turn.blockToTool.get(event.index);
          if (index !== undefined && delta.partial_json.length > 0) {
            this.emit({ type: "tool_call_args", index, delta: delta.partial_json });
          }
        }
        return;
      }
      case "message_delta":
        turn.stopReason = event.delta.stop_reason ?? null;
        turn.usage.output += event.usage?.output_tokens ?? 0;
        return;
      case "message_stop":
        return this.handleMessageStop(turn);
      default:
        return;
    }
  }

  private handleMessageStop(turn: ActiveTurn): void {
    switch (turn.stopReason) {
      case "tool_use":
        // Only calls for client tools end the HTTP turn; Claude Code runs anything else itself.
        if (turn.toolCalls.length > 0) this.finish("tool_calls");
        return;
      case "end_turn":
      case "stop_sequence":
        this.awaitingResult = true;
        return this.finish("stop");
      case "max_tokens":
        this.awaitingResult = true;
        return this.finish("length");
      case "refusal":
        this.awaitingResult = true;
        return this.finish("content_filter");
      default:
        return;
    }
  }

  private handleResult(result: Extract<SDKMessage, { type: "result" }>): void {
    for (const [name, usage] of Object.entries(result.modelUsage ?? {})) {
      if (usage.contextWindow > 0) {
        this.onLimits?.(name, {
          contextWindow: usage.contextWindow,
          maxOutputTokens: usage.maxOutputTokens,
        });
      }
    }
    if (this.awaitingResult) {
      this.awaitingResult = false;
      if (!result.is_error) return;
    }
    const turn = this.turn;
    if (!turn) {
      if (result.is_error) {
        log.warn("claude reported an error outside a turn", { session: this.id });
      }
      return;
    }
    if (result.is_error || result.subtype !== "success") {
      const detail =
        result.subtype === "success"
          ? result.result
          : (result.errors ?? []).join("; ") || result.subtype;
      this.endTurn({ type: "error", message: detail || "Claude Code reported an error." });
      this.close("turn failed");
      return;
    }
    // A turn that produced no stream events (rare) still has its text on the result.
    if (!turn.streamed && result.result) this.emit({ type: "text", delta: result.result });
    this.finish("stop");
  }

  private emit(event: TurnEvent): void {
    const turn = this.turn;
    if (!turn) return;
    turn.streamed = true;
    turn.events.push(event);
  }

  private finish(reason: FinishReason): void {
    const turn = this.turn;
    if (!turn) return;
    const ids = reason === "tool_calls" ? turn.toolCalls.map((c) => c.id) : [];
    this.transcript.push(...turn.incoming, assistantFingerprint(turn.text, ids));
    this.pendingToolIds = ids;
    this.state = reason === "tool_calls" ? "awaiting_tools" : "idle";
    this.lastUsed = Date.now();
    this.endTurn({ type: "done", finishReason: reason, usage: toUsage(turn.usage) });
  }

  private endTurn(final: TurnEvent): void {
    const turn = this.turn;
    if (!turn) return;
    this.turn = undefined;
    turn.events.push(final);
    turn.events.end();
  }
}

function buildOptions(options: SessionOptions, bridge: ToolBridge): Options {
  const { config } = options;
  const env: Record<string, string | undefined> = {
    ...process.env,
    ...config.env,
    CLAUDE_AGENT_SDK_CLIENT_APP: "conduit/0.1.0",
  };
  if (config.stripApiKey) delete env.ANTHROPIC_API_KEY;

  let effort: EffortLevel | undefined;
  if (options.effort !== undefined) {
    if (EFFORTS.has(options.effort)) effort = options.effort as EffortLevel;
    else log.warn("ignoring unknown effort", { effort: options.effort });
  }

  return {
    model: options.model,
    systemPrompt: options.system.trim().length > 0 ? options.system : DEFAULT_SYSTEM_PROMPT,
    // Claude acts as a model here: the client owns and runs every tool.
    tools: [],
    ...(options.tools.length > 0
      ? {
          mcpServers: {
            [BRIDGE_SERVER]: {
              type: "sdk" as const,
              name: BRIDGE_SERVER,
              instance: bridge.server,
              timeout: config.toolTimeoutSeconds * 1000,
            },
          },
        }
      : {}),
    strictMcpConfig: true,
    settingSources: config.settingSources,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    persistSession: false,
    includePartialMessages: true,
    cwd: config.cwd,
    env,
    ...(effort === undefined ? {} : { effort }),
    ...(config.reasoning === "none"
      ? {}
      : { thinking: { type: "adaptive", display: "summarized" } }),
    ...(config.binary === undefined ? {} : { pathToClaudeCodeExecutable: config.binary }),
    stderr: (data) => log.debug("claude stderr", { data: data.trimEnd() }),
  };
}

function toUsage(u: ActiveTurn["usage"]): Usage {
  const prompt = u.input + u.cacheRead + u.cacheWrite;
  return {
    prompt_tokens: prompt,
    completion_tokens: u.output,
    total_tokens: prompt + u.output,
    prompt_tokens_details: { cached_tokens: u.cacheRead },
  };
}

type StreamEvent = SDKPartialAssistantMessage["event"];
