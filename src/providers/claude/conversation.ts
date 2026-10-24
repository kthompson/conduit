import { createHash } from "node:crypto";
import {
  textOf,
  type ChatMessage,
  type ContentPart,
  type FunctionTool,
} from "../../openai/types.ts";

// Anthropic content blocks conduit sends to Claude Code.
export type UserBlock =
  | { type: "text"; text: string }
  | {
      type: "image";
      source: { type: "base64"; media_type: string; data: string } | { type: "url"; url: string };
    };

// MCP tool result content returned to Claude Code.
export type ToolResultContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

const hash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 16);
const normalize = (text: string) => text.replaceAll(/\s+/g, " ").trim();

/**
 * Splits a request into the system prompt (leading system/developer messages)
 * and the conversation. A system message after the first turn stays in the
 * conversation and is shown to Claude as user content.
 */
export function splitSystem(messages: ChatMessage[]): {
  system: string;
  conversation: ChatMessage[];
} {
  let i = 0;
  const parts: string[] = [];
  for (const m of messages) {
    if (m.role !== "system" && m.role !== "developer") break;
    parts.push(textOf(m.content));
    i++;
  }
  return { system: parts.join("\n\n"), conversation: messages.slice(i) };
}

/**
 * A stable identity for one message, used to recognize a request that
 * continues a live session. It is lenient where clients are known to rewrite
 * history: an assistant message with tool calls is identified by its call ids
 * alone, and whitespace never matters.
 */
export function fingerprint(message: ChatMessage): string {
  switch (message.role) {
    case "system":
    case "developer":
      return `s:${hash(normalize(textOf(message.content)))}`;
    case "user":
      return `u:${hash(normalize(textOf(message.content)) + "|" + countImages(message.content))}`;
    case "assistant":
      if (message.tool_calls && message.tool_calls.length > 0) {
        return `a:calls:${message.tool_calls.map((c) => c.id).join(",")}`;
      }
      return `a:${hash(normalize(textOf(message.content)))}`;
    case "tool":
      return `t:${message.tool_call_id}`;
  }
}

export function assistantFingerprint(text: string, toolCallIds: string[]): string {
  return toolCallIds.length > 0 ? `a:calls:${toolCallIds.join(",")}` : `a:${hash(normalize(text))}`;
}

/** Identity of everything fixed for the life of a Claude Code process. */
export function sessionKey(input: {
  system: string;
  tools: FunctionTool[] | undefined;
  model: string;
  effort: string | undefined;
}): string {
  const tools = (input.tools ?? []).map((t) => [
    t.function.name,
    t.function.description ?? "",
    t.function.parameters ?? {},
  ]);
  return hash(JSON.stringify([input.system, tools, input.model, input.effort ?? ""]));
}

function countImages(content: string | ContentPart[] | null | undefined): number {
  return Array.isArray(content) ? content.filter((p) => p.type === "image_url").length : 0;
}

export function toUserBlocks(content: string | ContentPart[] | null | undefined): UserBlock[] {
  if (content === null || content === undefined) return [];
  if (typeof content === "string") {
    return content.length === 0 ? [] : [{ type: "text", text: content }];
  }
  const blocks: UserBlock[] = [];
  for (const part of content) {
    if (part.type === "text" && typeof part.text === "string") {
      blocks.push({ type: "text", text: part.text });
    } else if (part.type === "image_url") {
      const url = (part as { image_url?: { url?: string } }).image_url?.url;
      const image = url ? imageFromUrl(url) : undefined;
      blocks.push(image ?? { type: "text", text: "[unsupported image]" });
    } else {
      blocks.push({ type: "text", text: `[unsupported content part: ${part.type}]` });
    }
  }
  return blocks;
}

function imageFromUrl(url: string): UserBlock | undefined {
  const [, mediaType, data] = /^data:([^;,]+);base64,(.*)$/s.exec(url) ?? [];
  if (mediaType !== undefined && data !== undefined) {
    return { type: "image", source: { type: "base64", media_type: mediaType, data } };
  }
  if (/^https?:\/\//.test(url)) return { type: "image", source: { type: "url", url } };
  return undefined;
}

export function toToolResultContent(content: string | ContentPart[]): ToolResultContent[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  const out: ToolResultContent[] = [];
  for (const block of toUserBlocks(content)) {
    if (block.type === "text") out.push(block);
    else if (block.source.type === "base64") {
      out.push({ type: "image", data: block.source.data, mimeType: block.source.media_type });
    } else {
      out.push({ type: "text", text: `[image: ${block.source.url}]` });
    }
  }
  return out.length > 0 ? out : [{ type: "text", text: "" }];
}
