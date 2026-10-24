import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import type { ReasoningOutput } from "../config.ts";
import type { TurnEvent } from "../providers/types.ts";
import type { Trace } from "../capture/recorder.ts";
import type { FinishReason, ToolCall, Usage } from "./types.ts";

interface Envelope {
  id: string;
  created: number;
  model: string;
}

function envelope(model: string): Envelope {
  return { id: `chatcmpl-${randomUUID()}`, created: Math.floor(Date.now() / 1000), model };
}

/**
 * Rewrites reasoning events for clients that do not read `reasoning_content`.
 * `think_tags` folds thinking into content as `<think>…</think>`.
 */
function* shapeReasoning(
  mode: ReasoningOutput,
  state: { open: boolean },
  event: TurnEvent,
): Generator<TurnEvent> {
  if (event.type === "reasoning") {
    if (mode === "none") return;
    if (mode === "reasoning_content") {
      yield event;
      return;
    }
    if (!state.open) {
      state.open = true;
      yield { type: "text", delta: "<think>\n" };
    }
    yield { type: "text", delta: event.delta };
    return;
  }
  if (mode === "think_tags" && state.open) {
    state.open = false;
    yield { type: "text", delta: "\n</think>\n\n" };
  }
  yield event;
}

export async function streamChat(
  res: ServerResponse,
  model: string,
  events: AsyncIterable<TurnEvent>,
  options: { includeUsage: boolean; reasoning: ReasoningOutput; trace: Trace },
): Promise<void> {
  const env = envelope(model);
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });

  const send = (payload: unknown) => {
    options.trace.chunk(payload);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };
  const chunk = (delta: Record<string, unknown>, finishReason: FinishReason | null = null) =>
    send({
      ...env,
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta, logprobs: null, finish_reason: finishReason }],
    });

  chunk({ role: "assistant", content: "" });
  const think = { open: false };
  let status = 200;
  try {
    for await (const raw of events) {
      for (const event of shapeReasoning(options.reasoning, think, raw)) {
        switch (event.type) {
          case "text":
            chunk({ content: event.delta });
            break;
          case "reasoning":
            chunk({ reasoning_content: event.delta });
            break;
          case "tool_call_start":
            chunk({
              tool_calls: [
                {
                  index: event.index,
                  id: event.id,
                  type: "function",
                  function: { name: event.name, arguments: "" },
                },
              ],
            });
            break;
          case "tool_call_args":
            chunk({ tool_calls: [{ index: event.index, function: { arguments: event.delta } }] });
            break;
          case "done":
            chunk({}, event.finishReason);
            if (options.includeUsage && event.usage) {
              send({ ...env, object: "chat.completion.chunk", choices: [], usage: event.usage });
            }
            break;
          case "error":
            status = 502;
            send({
              error: { message: event.message, type: "upstream_error", code: "upstream_error" },
            });
            break;
        }
      }
    }
  } catch (error) {
    status = 500;
    const message = error instanceof Error ? error.message : String(error);
    send({ error: { message, type: "internal_error", code: "internal_error" } });
  } finally {
    if (!res.writableEnded) {
      options.trace.chunk("[DONE]");
      res.end("data: [DONE]\n\n");
    }
    options.trace.finish(status);
  }
}

/** Collects a whole turn into a non-streaming `chat.completion` body. */
export async function collectChat(
  model: string,
  events: AsyncIterable<TurnEvent>,
  reasoningMode: ReasoningOutput,
): Promise<{ status: number; body: unknown }> {
  const env = envelope(model);
  let content = "";
  let reasoning = "";
  const toolCalls: ToolCall[] = [];
  let finishReason: FinishReason = "stop";
  let usage: Usage | undefined;
  const think = { open: false };

  for await (const raw of events) {
    for (const event of shapeReasoning(reasoningMode, think, raw)) {
      switch (event.type) {
        case "text":
          content += event.delta;
          break;
        case "reasoning":
          reasoning += event.delta;
          break;
        case "tool_call_start":
          toolCalls[event.index] = {
            id: event.id,
            type: "function",
            function: { name: event.name, arguments: "" },
          };
          break;
        case "tool_call_args": {
          const call = toolCalls[event.index];
          if (call) call.function.arguments += event.delta;
          break;
        }
        case "done":
          finishReason = event.finishReason;
          usage = event.usage;
          break;
        case "error":
          return {
            status: 502,
            body: {
              error: { message: event.message, type: "upstream_error", code: "upstream_error" },
            },
          };
      }
    }
  }

  const message: Record<string, unknown> = {
    role: "assistant",
    content: content.length > 0 ? content : null,
  };
  if (reasoning.length > 0) message.reasoning_content = reasoning;
  if (toolCalls.length > 0) message.tool_calls = toolCalls.filter(Boolean);
  return {
    status: 200,
    body: {
      ...env,
      object: "chat.completion",
      choices: [{ index: 0, message, logprobs: null, finish_reason: finishReason }],
      ...(usage ? { usage } : {}),
    },
  };
}
