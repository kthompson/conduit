import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { textOf, type ChatCompletionRequest } from "../../openai/types.ts";
import type { ModelEntry, Provider, TurnEvent, TurnInput } from "../types.ts";

const TOOL_COMMAND = /^\/tool\s+(\S+)(?:\s+([\s\S]+))?$/m;

/**
 * Simulates a model without calling one. It describes what the client sent,
 * which makes it the companion of capture mode, and fakes a tool round trip
 * when the last user message contains `/tool <name> {json args}`.
 */
export class MockProvider implements Provider {
  readonly name = "mock";
  private readonly delayMs: number;

  constructor(options: { delayMs?: number } = {}) {
    this.delayMs = options.delayMs ?? 15;
  }

  async listModels(): Promise<ModelEntry[]> {
    return [{ id: "mock", ownedBy: "conduit", displayName: "Mock (echoes the request)" }];
  }

  async *turn(input: TurnInput): AsyncIterable<TurnEvent> {
    const { request } = input;
    const last = request.messages.at(-1);

    if (last?.role === "user") {
      const match = TOOL_COMMAND.exec(textOf(last.content));
      if (match) {
        const [, name, args] = match;
        const known = request.tools?.some((t) => t.function.name === name) ?? false;
        if (!known) {
          yield* this.text(
            `Mock: no tool named \`${name}\` in this request. Tools: ${toolNames(request)}`,
          );
          yield { type: "done", finishReason: "stop", usage: undefined };
          return;
        }
        yield* this.text(`Calling \`${name}\`.`);
        const id = `call_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
        yield { type: "tool_call_start", index: 0, id, name: name ?? "" };
        yield { type: "tool_call_args", index: 0, delta: (args?.trim() ?? "") || "{}" };
        yield { type: "done", finishReason: "tool_calls", usage: undefined };
        return;
      }
    }

    if (last?.role === "tool") {
      const results = trailingToolResults(request);
      const lines = results.map((r) => `- \`${r.id}\`: ${truncate(r.text, 400)}`);
      yield* this.text(`Mock received ${results.length} tool result(s):\n${lines.join("\n")}`);
      yield { type: "done", finishReason: "stop", usage: undefined };
      return;
    }

    yield* this.text(describe(request));
    yield { type: "done", finishReason: "stop", usage: undefined };
  }

  async close(): Promise<void> {}

  private async *text(body: string): AsyncIterable<TurnEvent> {
    for (const piece of body.match(/\S+\s*|\s+/g) ?? []) {
      if (this.delayMs > 0) await sleep(this.delayMs);
      yield { type: "text", delta: piece };
    }
  }
}

function toolNames(request: ChatCompletionRequest): string {
  const names = request.tools?.map((t) => t.function.name) ?? [];
  return names.length === 0 ? "(none)" : names.map((n) => `\`${n}\``).join(", ");
}

function trailingToolResults(request: ChatCompletionRequest) {
  const out: Array<{ id: string; text: string }> = [];
  for (const m of request.messages.toReversed()) {
    if (m.role !== "tool") break;
    out.unshift({ id: m.tool_call_id, text: textOf(m.content) });
  }
  return out;
}

function describe(request: ChatCompletionRequest): string {
  const roles = new Map<string, number>();
  for (const m of request.messages) roles.set(m.role, (roles.get(m.role) ?? 0) + 1);
  const system = request.messages
    .filter((m) => m.role === "system" || m.role === "developer")
    .map((m) => textOf(m.content))
    .join("\n");
  const params = Object.keys(request).filter((k) => k !== "messages" && k !== "tools");
  return [
    `**conduit mock** — model \`${request.model}\`, stream=${request.stream === true}`,
    "",
    `- messages: ${[...roles].map(([r, n]) => `${r}×${n}`).join(", ")}`,
    `- system prompt: ${system.length} chars`,
    `- tools (${request.tools?.length ?? 0}): ${toolNames(request)}`,
    `- params: ${params.join(", ")}`,
    "",
    "Send `/tool <name> {json}` to simulate a tool call.",
  ].join("\n");
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}… (${text.length} chars)`;
}
