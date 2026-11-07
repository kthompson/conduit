import { Channel } from "../channel.ts";
import type { Trace } from "../capture/recorder.ts";
import { log } from "../log.ts";
import type { ChatMessage, FinishReason, FunctionTool, Usage } from "../openai/types.ts";
import { assistantFingerprint, type ToolResultContent, type UserBlock } from "./conversation.ts";
import type { SessionLike, SessionState } from "./matching.ts";
import { NO_RESULT_TEXT } from "./pendingTools.ts";
import type { TurnEvent, TurnFailure } from "./types.ts";

export interface TokenCounts {
  /** Prompt tokens that were not served from cache. */
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

export interface SessionIdentity {
  key: string;
  /** Which configured provider (login) this process runs under. */
  providerId: string;
  model: string;
}

/** Everything a session is created with, whichever agent it runs. */
export interface SessionSpec extends SessionIdentity {
  effort: string | undefined;
  system: string;
  tools: FunctionTool[];
  /** Earlier conversation to resume as real turns; empty or omitted for a fresh session. */
  history?: ChatMessage[];
}

interface ActiveTurn {
  events: Channel<TurnEvent>;
  trace: Trace;
  /** Fingerprints of the request messages this turn answers; committed when it finishes. */
  incoming: string[];
  text: string;
  toolCalls: Array<{ id: string; name: string }>;
  usage: TokenCounts;
  streamed: boolean;
}

/**
 * One live agent process holding one conversation. Turns arrive as separate
 * HTTP requests; the process and its prompt cache stay warm between them,
 * including across a client-side tool round trip.
 *
 * This class owns everything that does not depend on which agent it is: the
 * turn lifecycle, the transcript used to recognize a continuing request, the
 * tool-call hand-off to the client and shutdown. Subclasses translate the
 * agent's own event stream into `emit`, `finish` and `fail` calls.
 */
export abstract class BaseSession implements SessionLike {
  readonly id = crypto.randomUUID().slice(0, 8);
  readonly key: string;
  readonly providerId: string;
  readonly model: string;
  state: SessionState = "idle";
  lastUsed = Date.now();
  /** Fingerprints of every conversation message the model has seen, in order. */
  readonly transcript: string[] = [];
  /** Tool calls from the last turn that the client still has to answer. */
  pendingToolIds: string[] = [];

  protected turn: ActiveTurn | undefined;
  private readonly onClose: (session: never) => void;

  /** Human name of the agent, for log lines and error messages. */
  protected abstract readonly label: string;

  constructor(identity: SessionIdentity, onClose: (session: never) => void) {
    this.key = identity.key;
    this.providerId = identity.providerId;
    this.model = identity.model;
    this.onClose = onClose;
  }

  /** Starts a turn from new user content. */
  abstract sendUser(
    blocks: UserBlock[],
    incoming: string[],
    trace: Trace,
    signal: AbortSignal,
  ): AsyncIterable<TurnEvent>;

  /** Stops the agent process and releases everything it held. Called once, after the turn has ended. */
  protected abstract teardown(reason: string): void;

  /** Hands the client's result for a tool call back to the agent. */
  protected abstract deliverResult(callId: string, content: ToolResultContent[]): void;

  /** Whether `reason` (the agent's last known error or the close reason) means the login is rate limited or logged out. */
  protected abstract failureFor(reason: string): TurnFailure | undefined;

  /** Resets per-turn state the subclass keeps. */
  protected onTurnBegin(): void {}

  /** Resumes a turn that stopped for tool calls by handing the model the client's results. */
  sendToolResults(
    results: Array<{ id: string; content: ToolResultContent[] }>,
    incoming: string[],
    trace: Trace,
    signal: AbortSignal,
  ): AsyncIterable<TurnEvent> {
    const events = this.begin(incoming, trace, signal);
    const answered = new Set(results.map((r) => r.id));
    for (const r of results) this.deliverResult(r.id, r.content);
    for (const id of this.pendingToolIds) {
      if (!answered.has(id)) {
        this.deliverResult(id, [{ type: "text", text: NO_RESULT_TEXT }]);
      }
    }
    this.pendingToolIds = [];
    return events;
  }

  close(reason: string): void {
    if (this.state === "closed") return;
    this.state = "closed";
    log.debug(`${this.label} session closed`, { session: this.id, reason });
    if (this.turn) {
      const failure = this.failureFor(reason);
      this.endTurn({
        type: "error",
        message: `${this.label} session closed: ${reason}`,
        ...(failure ? { failure } : {}),
      });
    }
    this.teardown(reason);
    this.onClose(this as never);
  }

  protected begin(incoming: string[], trace: Trace, signal: AbortSignal): AsyncIterable<TurnEvent> {
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
      usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
      streamed: false,
    };
    this.onTurnBegin();
    trace.note(`${this.label.toLowerCase()} session`, {
      session: this.id,
      model: this.model,
      transcriptLength: this.transcript.length,
    });
    signal.addEventListener(
      "abort",
      () => {
        // The client's history no longer matches the agent's, so the process cannot be reused.
        if (this.turn?.events === events) this.close("client disconnected mid-turn");
      },
      { once: true },
    );
    return events;
  }

  protected emit(event: TurnEvent): void {
    const turn = this.turn;
    if (!turn) return;
    turn.streamed = true;
    if (event.type === "text") turn.text += event.delta;
    turn.events.push(event);
  }

  /** Records a client-facing tool call and tells the client about it. Returns its index. */
  protected startToolCall(id: string, name: string): number {
    const turn = this.turn;
    if (!turn) return -1;
    const index = turn.toolCalls.length;
    turn.toolCalls.push({ id, name });
    this.emit({ type: "tool_call_start", index, id, name });
    return index;
  }

  protected finish(reason: FinishReason): void {
    const turn = this.turn;
    if (!turn) return;
    const ids = reason === "tool_calls" ? turn.toolCalls.map((c) => c.id) : [];
    this.transcript.push(...turn.incoming, assistantFingerprint(turn.text, ids));
    this.pendingToolIds = ids;
    this.state = reason === "tool_calls" ? "awaiting_tools" : "idle";
    this.lastUsed = Date.now();
    this.endTurn({ type: "done", finishReason: reason, usage: toUsage(turn.usage) });
  }

  /** Ends the turn with an error and discards the session: its state can no longer be trusted. */
  protected fail(message: string, failure: TurnFailure | undefined): void {
    this.endTurn({ type: "error", message, ...(failure ? { failure } : {}) });
    this.close("turn failed");
  }

  protected endTurn(final: TurnEvent): void {
    const turn = this.turn;
    if (!turn) return;
    this.turn = undefined;
    turn.events.push(final);
    turn.events.end();
  }
}

export function toUsage(u: TokenCounts): Usage {
  const prompt = u.input + u.cacheRead + u.cacheWrite;
  return {
    prompt_tokens: prompt,
    completion_tokens: u.output,
    total_tokens: prompt + u.output,
    prompt_tokens_details: { cached_tokens: u.cacheRead },
  };
}
