import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { FunctionTool } from "../../openai/types.ts";
import type { ToolResultContent } from "../conversation.ts";
import { aliasFor as aliasForName, PendingToolCalls, type ToolResult } from "../pendingTools.ts";
import { log } from "../../log.ts";

export const BRIDGE_SERVER = "tools";
const PREFIX = `mcp__${BRIDGE_SERVER}__`;
const MAX_TOOL_NAME = 64;

/**
 * Exposes the client's function tools to Claude Code as an in-process MCP
 * server. Claude Code calls a tool as soon as its tool_use block is complete,
 * but the client only runs tools after the HTTP response ends, so each call
 * waits in the shared pending-call table until `deliver` hands over the
 * client's result.
 *
 * Calls are matched by the tool_use id Claude Code puts in the request's
 * `_meta["claudecode/toolUseId"]`, which is also the id the client sees.
 */
export class ToolBridge {
  readonly server: McpServer;
  private readonly toClient = new Map<string, string>();
  private readonly toClaude = new Map<string, string>();
  private readonly pending = new PendingToolCalls();

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
        name: this.toClaude.get(t.function.name) ?? t.function.name,
        description: t.function.description ?? "",
        inputSchema: normalizeSchema(t.function.parameters),
      })),
    }));
    this.server.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const id = extra._meta?.["claudecode/toolUseId"];
      if (typeof id !== "string") {
        log.warn("claude tool call without a tool_use id", { tool: request.params.name });
        return errorResult("conduit could not match this tool call to the client.");
      }
      return toCallToolResult(await this.pending.wait(id, extra.signal));
    });
  }

  /** Client-facing name for a full Claude Code tool name, or undefined when it is not a bridged tool. */
  clientName(claudeToolName: string): string | undefined {
    if (!claudeToolName.startsWith(PREFIX)) return undefined;
    return this.toClient.get(claudeToolName.slice(PREFIX.length));
  }

  /** Full Claude Code tool name for a client tool, as it appears in tool_use blocks. */
  claudeName(clientName: string): string {
    return PREFIX + (this.toClaude.get(clientName) ?? aliasFor(clientName));
  }

  deliver(toolUseId: string, content: ToolResultContent[]): void {
    this.pending.deliver(toolUseId, content);
  }

  /** Ends every waiting call, e.g. when the session closes. */
  cancelAll(reason: string): void {
    this.pending.cancelAll(reason);
  }
}

function aliasFor(name: string): string {
  return aliasForName(name, PREFIX.length, MAX_TOOL_NAME);
}

function normalizeSchema(parameters: Record<string, unknown> | undefined): {
  type: "object";
  [k: string]: unknown;
} {
  if (parameters && parameters.type === "object") return parameters as { type: "object" };
  return { type: "object", properties: {}, ...parameters };
}

function errorResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function toCallToolResult(result: ToolResult): CallToolResult {
  return result.isError ? { content: result.content, isError: true } : { content: result.content };
}
