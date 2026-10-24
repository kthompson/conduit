// The subset of the OpenAI Chat Completions wire format conduit reads and writes.

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: string } }
  | { type: string; [key: string]: unknown };

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: "system" | "developer"; content: string | ContentPart[]; name?: string }
  | { role: "user"; content: string | ContentPart[]; name?: string }
  | {
      role: "assistant";
      content?: string | ContentPart[] | null;
      tool_calls?: ToolCall[];
      reasoning_content?: string;
      name?: string;
    }
  | { role: "tool"; content: string | ContentPart[]; tool_call_id: string };

export interface FunctionTool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
    strict?: boolean;
  };
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  tools?: FunctionTool[];
  tool_choice?: unknown;
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
  reasoning_effort?: string;
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  [key: string]: unknown;
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: { cached_tokens: number };
}

export type FinishReason = "stop" | "length" | "tool_calls" | "content_filter";

export function textOf(content: string | ContentPart[] | null | undefined): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  return content
    .map((part) => (part.type === "text" && typeof part.text === "string" ? part.text : ""))
    .join("");
}

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, message: string, code = "invalid_request_error") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function errorBody(message: string, code: string) {
  return { error: { message, type: code, code } };
}
