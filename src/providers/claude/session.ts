import {
  query,
  type Query,
  type SDKMessage,
  type SDKPartialAssistantMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { Channel } from "../../channel.ts";
import type { Trace } from "../../capture/recorder.ts";
import { log } from "../../log.ts";
import type { ToolResultContent, UserBlock } from "../conversation.ts";
import { classifyFailure as classify } from "../failure.ts";
import { BaseSession } from "../session.ts";
import type { TurnEvent, TurnFailure } from "../types.ts";
import { buildOptions, resumeOptions, type SessionOptions } from "./options.ts";
import { ToolBridge } from "./toolBridge.ts";

export type { SessionOptions } from "./options.ts";

/**
 * One live Claude Code process holding one conversation. The turn lifecycle
 * lives in `BaseSession`; this class translates Claude Code's stream into it
 * and bridges the client's tools through an in-process MCP server.
 */
export class ClaudeSession extends BaseSession {
  protected readonly label = "Claude";

  private readonly input = new Channel<SDKUserMessage>();
  private readonly bridge: ToolBridge;
  private readonly query: Query;
  /** Which tool call each open content block belongs to, by block index. */
  private blockToTool = new Map<number, number>();
  private stopReason: string | null = null;
  /** The finished turn's `result` message is still to come and belongs to no turn. */
  private awaitingResult = false;
  /** What Claude Code last said about why requests are failing, used to classify a failed turn. */
  private lastError: { code: string | undefined; resetsAt: number | undefined } = {
    code: undefined,
    resetsAt: undefined,
  };

  private readonly onLimits: SessionOptions["onLimits"];
  /** Removes the scratch config dir of a resumed session. */
  private cleanup: (() => void) | undefined;

  constructor(options: SessionOptions, onClose: (session: ClaudeSession) => void) {
    super(options, onClose);
    this.onLimits = options.onLimits;
    this.bridge = new ToolBridge(options.tools);
    const resume = resumeOptions(options, this.bridge);
    this.cleanup = resume.cleanup;
    this.query = query({
      prompt: this.input,
      options: { ...buildOptions(options, this.bridge), ...resume.options },
    });
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

  protected deliverResult(callId: string, content: ToolResultContent[]): void {
    this.bridge.deliver(callId, content);
  }

  protected failureFor(reason: string): TurnFailure | undefined {
    return classifyFailure(this.lastError.code, reason, this.lastError.resetsAt);
  }

  protected teardown(reason: string): void {
    this.bridge.cancelAll(`Session closed: ${reason}`);
    this.input.end();
    this.query.close();
    this.cleanup?.();
  }

  protected override onTurnBegin(): void {
    this.blockToTool.clear();
    this.stopReason = null;
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
      case "assistant":
        if (message.error) this.lastError.code = message.error;
        return;
      case "rate_limit_event":
        if (message.rate_limit_info.status === "rejected") {
          this.lastError.code = "rate_limit";
          const reset = message.rate_limit_info.resetsAt;
          // The SDK reports epoch seconds.
          this.lastError.resetsAt = reset === undefined ? undefined : reset * 1000;
        }
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
        this.blockToTool.clear();
        this.stopReason = null;
        return;
      }
      case "content_block_start": {
        const block = event.content_block;
        if (block.type !== "tool_use") return;
        const name = this.bridge.clientName(block.name);
        // A tool the client does not know is Claude Code's own business; it answers it and continues.
        if (name === undefined) return;
        this.blockToTool.set(event.index, this.startToolCall(block.id, name));
        return;
      }
      case "content_block_delta": {
        const delta = event.delta;
        if (delta.type === "text_delta") {
          this.emit({ type: "text", delta: delta.text });
        } else if (delta.type === "thinking_delta") {
          this.emit({ type: "reasoning", delta: delta.thinking });
        } else if (delta.type === "input_json_delta") {
          const index = this.blockToTool.get(event.index);
          if (index !== undefined && delta.partial_json.length > 0) {
            this.emit({ type: "tool_call_args", index, delta: delta.partial_json });
          }
        }
        return;
      }
      case "message_delta":
        this.stopReason = event.delta.stop_reason ?? null;
        turn.usage.output += event.usage?.output_tokens ?? 0;
        return;
      case "message_stop":
        return this.handleMessageStop(turn.toolCalls.length);
      default:
        return;
    }
  }

  private handleMessageStop(toolCalls: number): void {
    switch (this.stopReason) {
      case "tool_use":
        // Only calls for client tools end the HTTP turn; Claude Code runs anything else itself.
        if (toolCalls > 0) this.finish("tool_calls");
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
      const message = detail || "Claude Code reported an error.";
      return this.fail(
        message,
        classifyFailure(this.lastError.code, message, this.lastError.resetsAt),
      );
    }
    // A turn that produced no stream events (rare) still has its text on the result.
    if (!turn.streamed && result.result) this.emit({ type: "text", delta: result.result });
    this.finish("stop");
  }
}

const AUTH_ERRORS = new Set([
  "authentication_failed",
  "oauth_org_not_allowed",
  "account_on_hold",
  "verification_required",
  "billing_error",
]);

/** Decides whether a failed turn says the provider is rate limited or logged out. */
export function classifyFailure(
  code: string | undefined,
  message: string,
  resetsAt?: number,
): TurnFailure | undefined {
  return classify(code, message, { resetsAt, authCodes: AUTH_ERRORS });
}

type StreamEvent = SDKPartialAssistantMessage["event"];
