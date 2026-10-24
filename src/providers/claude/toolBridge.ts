import { createHash } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { FunctionTool } from "../../openai/types.ts";
import type { ToolResultContent } from "./conversation.ts";
import { log } from "../../log.ts";

export const BRIDGE_SERVER = "tools";
const PREFIX = `mcp__${BRIDGE_SERVER}__`;
const MAX_TOOL_NAME = 64;

/**
 * Exposes the client's function tools to Claude Code as an in-process MCP
 * server. Claude Code calls a tool as soon as its tool_use block is complete,
 * but the client only runs tools after the HTTP response ends, so each call
 * waits here until `deliver` hands over the client's result.
 *
 * Calls are matched by the tool_use id Claude Code puts in the request's
 * `_meta["claudecode/toolUseId"]`, which is also the id the client sees.
 */
export class ToolBridge {
  readonly server: McpServer;
  private readonly toClient = new Map<string, string>();
  private readonly toClaude = new Map<string, string>();
  private readonly results = new Map<string, CallToolResult>();
  private readonly waiters = new Map<string, (result: CallToolResult) => void>();

  constructor(tools: FunctionTool[]) {
    for (const tool of tools) {
      const alias = aliasFor(tool.function.name);
      this.toClient.set(alias, tool.function.name);
      this.toClaude.set(tool.function.name, alias);
    }

    this.server = new McpServer(
      { name: BRIDGE_SERVER, version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    this.server.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: tools.map((t) => ({
        name: this.toClaude.get(t.function.name)!,
        description: t.function.description ?? "",
        inputSchema: normalizeSchema(t.function.parameters),
      })),
    }));
    this.server.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const id = (extra._meta as Record<string, unknown> | undefined)?.["claudecode/toolUseId"];
      if (typeof id !== "string") {
        log.warn("claude tool call without a tool_use id", { tool: request.params.name });
        return errorResult("conduit could not match this tool call to the client.");
      }
      return this.wait(id, extra.signal);
    });
  }

  /** Client-facing name for a full Claude Code tool name, or undefined when it is not a bridged tool. */
  clientName(claudeToolName: string): string | undefined {
    if (!claudeToolName.startsWith(PREFIX)) return undefined;
    return this.toClient.get(claudeToolName.slice(PREFIX.length));
  }

  deliver(toolUseId: string, content: ToolResultContent[]): void {
    const result: CallToolResult = { content };
    const waiter = this.waiters.get(toolUseId);
    if (waiter) {
      this.waiters.delete(toolUseId);
      waiter(result);
    } else {
      this.results.set(toolUseId, result);
    }
  }

  /** Ends every waiting call, e.g. when the session closes. */
  cancelAll(reason: string): void {
    for (const [id, waiter] of this.waiters) {
      this.waiters.delete(id);
      waiter(errorResult(reason));
    }
    this.results.clear();
  }

  private wait(id: string, signal: AbortSignal): Promise<CallToolResult> {
    const ready = this.results.get(id);
    if (ready) {
      this.results.delete(id);
      return Promise.resolve(ready);
    }
    return new Promise((resolve) => {
      this.waiters.set(id, resolve);
      signal.addEventListener(
        "abort",
        () => {
          if (this.waiters.get(id) === resolve) {
            this.waiters.delete(id);
            resolve(errorResult("Tool call was cancelled."));
          }
        },
        { once: true },
      );
    });
  }
}

function aliasFor(name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (PREFIX.length + safe.length <= MAX_TOOL_NAME) return safe;
  const digest = createHash("sha256").update(name).digest("hex").slice(0, 8);
  return `${safe.slice(0, MAX_TOOL_NAME - PREFIX.length - 9)}_${digest}`;
}

function normalizeSchema(parameters: Record<string, unknown> | undefined): {
  type: "object";
  [k: string]: unknown;
} {
  if (parameters && parameters.type === "object") return parameters as { type: "object" };
  return { type: "object", properties: {}, ...(parameters ?? {}) } as { type: "object" };
}

function errorResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}
