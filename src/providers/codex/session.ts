import type { Trace } from "../../capture/recorder.ts";
import type { CodexConfig } from "../../config.ts";
import { log } from "../../log.ts";
import type { ToolResultContent, UserBlock } from "../conversation.ts";
import { classifyFailure as classify } from "../failure.ts";
import { aliasFor, PendingToolCalls, type ToolResult } from "../pendingTools.ts";
import { BaseSession, type SessionSpec } from "../session.ts";
import type { TurnEvent, TurnFailure } from "../types.ts";
import { launchCodex, RpcError, type AppServerClient } from "./appServer.ts";
import { buildSeedItems } from "./seed.ts";

const DEFAULT_SYSTEM_PROMPT = "You are a helpful assistant.";

/** Codex ships with a shell, a patch tool and sub-agents; none of them belong to the model here. */
const TOOL_RULES =
  "You have no shell, no filesystem and no other agents. Act only through the functions the user's " +
  "environment provides to you, and answer directly when no function is needed.";

/** Error kinds Codex reports in `codexErrorInfo` that mean the plan is used up. */
const RATE_LIMIT_KINDS = new Set([
  "usageLimitExceeded",
  "rateLimitExceeded",
  "sessionBudgetExceeded",
]);
const AUTH_KINDS = new Set(["unauthorized"]);

export interface CodexSessionOptions extends SessionSpec {
  config: CodexConfig;
  /** Receives the context window Codex reports for the model after a turn. */
  onContextWindow?: (model: string, contextWindow: number) => void;
}

interface TokenBreakdown {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
}

interface RateLimitWindow {
  usedPercent: number;
  resetsAt: number | null;
}

interface Params {
  threadId?: string;
  [key: string]: unknown;
}

/** The name Codex reports in `codexErrorInfo`, whether it came as a bare string or a tagged object. */
export function errorKind(info: unknown): string | undefined {
  if (typeof info === "string") return info;
  if (info !== null && typeof info === "object") return Object.keys(info)[0];
  return undefined;
}

/** Decides whether a failed Codex turn says the plan is used up or the login is gone. */
export function classifyCodexFailure(
  info: unknown,
  message: string,
  resetsAt?: number,
): TurnFailure | undefined {
  const kind = errorKind(info);
  const code = kind !== undefined && RATE_LIMIT_KINDS.has(kind) ? "rate_limit" : kind;
  return classify(code, message, { resetsAt, authCodes: AUTH_KINDS });
}

/**
 * One live `codex app-server` process holding one thread. The turn lifecycle
 * lives in `BaseSession`; this class drives the thread over JSON-RPC and
 * exposes the client's tools to Codex as dynamic tools.
 *
 * Codex calls a dynamic tool by sending a request and waiting for the answer,
 * so a call stays open until the HTTP client returns its result. Calls that
 * arrive close together are handed to the client as one batch.
 */
export class CodexSession extends BaseSession {
  protected readonly label = "Codex";

  private readonly config: CodexConfig;
  private readonly effort: string | undefined;
  private readonly pending = new PendingToolCalls();
  private readonly toClient = new Map<string, string>();
  private readonly toCodex = new Map<string, string>();
  private readonly onContextWindow: CodexSessionOptions["onContextWindow"];
  private readonly ready: Promise<string>;
  private client: AppServerClient | undefined;
  private dispose: (() => void) | undefined;
  private threadId: string | undefined;
  /** Calls that arrived while no HTTP turn was open; the next turn announces them. */
  private lateCalls: Array<{ callId: string; name: string; args: string }> = [];
  private settleTimer: NodeJS.Timeout | undefined;
  private lastTotal: TokenBreakdown | undefined;
  private lastError: { info: unknown; message: string } | undefined;
  private rateLimitWindows: RateLimitWindow[] = [];
  private warnedBuiltIn = false;

  constructor(options: CodexSessionOptions, onClose: (session: CodexSession) => void) {
    super(options, onClose);
    this.config = options.config;
    this.effort = options.effort;
    this.onContextWindow = options.onContextWindow;
    for (const tool of options.tools) {
      const alias = aliasFor(tool.function.name);
      this.toClient.set(alias, tool.function.name);
      this.toCodex.set(tool.function.name, alias);
    }
    this.ready = this.boot(options);
    // A failed boot is reported through the first turn; this only keeps it from being unhandled.
    this.ready.catch(() => {});
  }

  /** Starts a turn from new user content. */
  sendUser(
    blocks: UserBlock[],
    incoming: string[],
    trace: Trace,
    signal: AbortSignal,
  ): AsyncIterable<TurnEvent> {
    const events = this.begin(incoming, trace, signal);
    void this.startCodexTurn(blocks);
    return events;
  }

  protected deliverResult(callId: string, content: ToolResultContent[]): void {
    this.pending.deliver(callId, content);
  }

  protected failureFor(reason: string): TurnFailure | undefined {
    return classifyCodexFailure(
      this.lastError?.info,
      this.lastError?.message ?? reason,
      this.resetsAt(),
    );
  }

  protected teardown(reason: string): void {
    clearTimeout(this.settleTimer);
    this.pending.cancelAll(`Session closed: ${reason}`);
    this.dispose?.();
  }

  protected override onTurnBegin(): void {
    const late = this.lateCalls;
    this.lateCalls = [];
    for (const call of late) this.announce(call.callId, call.name, call.args);
  }

  private async boot(options: CodexSessionOptions): Promise<string> {
    const { client, dispose } = await launchCodex(this.config, {
      onNotification: (method, params) => this.handleNotification(method, params as Params),
      onRequest: (method, params) => this.handleRequest(method, params as Params),
      onExit: (reason) => this.close(reason),
    });
    if (this.state === "closed") {
      dispose();
      throw new Error("session closed while starting");
    }
    this.client = client;
    this.dispose = dispose;
    const started = await client.request<{ thread: { id: string } }>("thread/start", {
      model: options.model,
      cwd: this.config.cwd,
      approvalPolicy: "never",
      sandbox: "read-only",
      // No environment means no shell and no file access, whatever the model asks for.
      environments: [],
      ephemeral: true,
      baseInstructions: options.system.trim().length > 0 ? options.system : DEFAULT_SYSTEM_PROMPT,
      developerInstructions: TOOL_RULES,
      dynamicTools: options.tools.map((t) => ({
        type: "function",
        name: this.toCodex.get(t.function.name) ?? t.function.name,
        description: t.function.description ?? "",
        inputSchema: normalizeSchema(t.function.parameters),
      })),
    });
    const threadId = started.thread.id;
    this.threadId = threadId;
    if (options.history && options.history.length > 0) {
      const items = buildSeedItems(
        options.history,
        (name) => this.toCodex.get(name) ?? aliasFor(name),
      );
      if (items.length > 0) await client.request("thread/inject_items", { threadId, items });
    }
    log.debug("codex session ready", { session: this.id, thread: threadId });
    return threadId;
  }

  private async startCodexTurn(blocks: UserBlock[]): Promise<void> {
    try {
      const threadId = await this.ready;
      await this.client?.request("turn/start", {
        threadId,
        input: blocks.map(toUserInput),
        ...(this.effort === undefined ? {} : { effort: this.effort }),
      });
    } catch (error) {
      if (this.turn === undefined) return;
      const message = error instanceof Error ? error.message : String(error);
      const info = error instanceof RpcError ? undefined : this.lastError?.info;
      this.fail(message, classifyCodexFailure(info, message, this.resetsAt()));
    }
  }

  private handleNotification(method: string, params: Params): void {
    if (params.threadId !== undefined && params.threadId !== this.threadId) return;
    this.turn?.trace.upstream({ method, params });
    switch (method) {
      case "item/agentMessage/delta":
        return this.emit({ type: "text", delta: deltaOf(params) });
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta":
        return this.emit({ type: "reasoning", delta: deltaOf(params) });
      case "item/reasoning/summaryPartAdded":
        // A new summary paragraph; keep it apart from the previous one.
        if (Number(params.summaryIndex) > 0) this.emit({ type: "reasoning", delta: "\n\n" });
        return;
      case "item/started":
        return this.noteBuiltIn(params.item as { type?: string } | undefined);
      case "thread/tokenUsage/updated":
        return this.handleUsage(params as unknown as TokenUsageParams);
      case "account/rateLimits/updated":
        return this.handleRateLimits(params.rateLimits as RateLimitsSnapshot | undefined);
      case "error": {
        const error = params.error as { message?: string; codexErrorInfo?: unknown } | undefined;
        if (params.willRetry === true) return;
        this.lastError = {
          info: error?.codexErrorInfo,
          message: error?.message ?? "Codex reported an error.",
        };
        return;
      }
      case "turn/completed":
        return this.handleCompleted(
          params.turn as {
            status: string;
            error: { message?: string; codexErrorInfo?: unknown } | null;
          },
        );
      default:
        return;
    }
  }

  private async handleRequest(method: string, params: Params): Promise<unknown> {
    switch (method) {
      case "item/tool/call":
        return this.handleToolCall(params as unknown as ToolCallParams);
      // Codex is only a model here: anything that wants to act on the machine is refused.
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
        return { decision: "decline" };
      case "applyPatchApproval":
      case "execCommandApproval":
        return { decision: "abort" };
      case "item/tool/requestUserInput":
        return { answers: {} };
      case "mcpServer/elicitation/request":
        return { action: "decline", content: null, _meta: null };
      default:
        throw new RpcError(-32601, `conduit does not handle ${method}`);
    }
  }

  private async handleToolCall(call: ToolCallParams): Promise<unknown> {
    const name = this.toClient.get(call.tool);
    if (name === undefined) {
      return toolResponse({
        content: [{ type: "text", text: `Unknown tool "${call.tool}".` }],
        isError: true,
      });
    }
    const args = JSON.stringify(call.arguments ?? {});
    if (this.turn) this.announce(call.callId, name, args);
    else this.lateCalls.push({ callId: call.callId, name, args });
    return toolResponse(await this.pending.wait(call.callId));
  }

  /** Tells the client about a tool call, then waits briefly for siblings before ending the turn. */
  private announce(callId: string, name: string, args: string): void {
    const turn = this.turn;
    if (!turn) return;
    const index = this.startToolCall(callId, name);
    this.emit({ type: "tool_call_args", index, delta: args });
    clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => {
      if (this.turn === turn) this.finish("tool_calls");
    }, this.config.toolSettleMs);
  }

  private handleUsage(params: TokenUsageParams): void {
    const total = params.tokenUsage.total;
    const before = this.lastTotal;
    this.lastTotal = total;
    const window = params.tokenUsage.modelContextWindow;
    if (window !== null && window > 0) this.onContextWindow?.(this.model, window);
    const turn = this.turn;
    if (!turn) return;
    const cached = total.cachedInputTokens - (before?.cachedInputTokens ?? 0);
    const input = total.inputTokens - (before?.inputTokens ?? 0);
    turn.usage.input += Math.max(0, input - cached);
    turn.usage.cacheRead += cached;
    turn.usage.cacheWrite += total.cacheWriteInputTokens - (before?.cacheWriteInputTokens ?? 0);
    turn.usage.output += total.outputTokens - (before?.outputTokens ?? 0);
  }

  private handleRateLimits(snapshot: RateLimitsSnapshot | undefined): void {
    if (!snapshot) return;
    this.rateLimitWindows = [snapshot.primary, snapshot.secondary].filter(
      (w): w is RateLimitWindow => w !== null,
    );
  }

  /** When the exhausted plan window lifts, in epoch milliseconds, if Codex told us. */
  private resetsAt(): number | undefined {
    const spent = this.rateLimitWindows.filter((w) => w.usedPercent >= 100 && w.resetsAt !== null);
    const latest = Math.max(...spent.map((w) => w.resetsAt ?? 0));
    return spent.length === 0 ? undefined : latest * 1000;
  }

  private handleCompleted(turn: {
    status: string;
    error: { message?: string; codexErrorInfo?: unknown } | null;
  }): void {
    if (!this.turn) return;
    if (turn.status === "completed") return this.finish("stop");
    const message =
      turn.error?.message ??
      this.lastError?.message ??
      (turn.status === "interrupted" ? "Codex turn was interrupted." : "Codex reported an error.");
    const info = turn.error?.codexErrorInfo ?? this.lastError?.info;
    if (errorKind(info) === "contextWindowExceeded") {
      return this.fail(message, undefined);
    }
    this.fail(message, classifyCodexFailure(info, message, this.resetsAt()));
  }

  private noteBuiltIn(item: { type?: string } | undefined): void {
    const type = item?.type;
    const builtIn = ["commandExecution", "fileChange", "mcpToolCall", "collabAgentToolCall"];
    if (type === undefined || !builtIn.includes(type) || this.warnedBuiltIn) return;
    this.warnedBuiltIn = true;
    log.warn("codex tried to use one of its own tools", { session: this.id, item: type });
  }
}

interface ToolCallParams {
  callId: string;
  tool: string;
  arguments: unknown;
}

interface TokenUsageParams {
  tokenUsage: { total: TokenBreakdown; modelContextWindow: number | null };
}

interface RateLimitsSnapshot {
  primary: RateLimitWindow | null;
  secondary: RateLimitWindow | null;
}

function deltaOf(params: Params): string {
  return typeof params.delta === "string" ? params.delta : "";
}

function toUserInput(block: UserBlock): Record<string, unknown> {
  if (block.type === "text") return { type: "text", text: block.text, text_elements: [] };
  const url =
    block.source.type === "base64"
      ? `data:${block.source.media_type};base64,${block.source.data}`
      : block.source.url;
  return { type: "image", url };
}

function toolResponse(result: ToolResult): {
  contentItems: Array<{ type: string; text?: string; imageUrl?: string }>;
  success: boolean;
} {
  const contentItems: Array<{ type: string; text?: string; imageUrl?: string }> =
    result.content.map((c) =>
      c.type === "text"
        ? { type: "inputText", text: c.text }
        : { type: "inputImage", imageUrl: `data:${c.mimeType};base64,${c.data}` },
    );
  if (contentItems.length === 0) contentItems.push({ type: "inputText", text: "" });
  return { contentItems, success: !result.isError };
}

function normalizeSchema(parameters: Record<string, unknown> | undefined): Record<string, unknown> {
  if (parameters && parameters.type === "object") return parameters;
  return { type: "object", properties: {}, ...parameters };
}
