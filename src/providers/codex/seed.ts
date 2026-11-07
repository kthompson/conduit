import { textOf, type ChatMessage } from "../../openai/types.ts";
import { toToolResultContent, toUserBlocks, type UserBlock } from "../conversation.ts";
import { NO_RESULT_TEXT } from "../pendingTools.ts";

type Item = Record<string, unknown>;

function inputParts(blocks: UserBlock[]): Item[] {
  return blocks.map((b) =>
    b.type === "text"
      ? { type: "input_text", text: b.text }
      : {
          type: "input_image",
          image_url:
            b.source.type === "base64"
              ? `data:${b.source.media_type};base64,${b.source.data}`
              : b.source.url,
        },
  );
}

/** Tool output as the Responses API carries it: text, with images as data URLs on their own lines. */
function outputText(message: ChatMessage & { role: "tool" }): string {
  return toToolResultContent(message.content)
    .map((c) => (c.type === "text" ? c.text : `[image: data:${c.mimeType};base64,${c.data}]`))
    .join("\n");
}

/**
 * Turns an OpenAI-style history into the Responses API items Codex keeps as
 * its model-visible history (`thread/inject_items`), so a new thread can
 * resume it as real turns. Reasoning is not replayed: it is the client's
 * summary, not Codex's.
 *
 * `toolName` maps a client tool name to the name Codex sees.
 */
export function buildSeedItems(
  history: ChatMessage[],
  toolName: (clientName: string) => string,
): Item[] {
  const items: Item[] = [];
  let userParts: Item[] = [];
  const flushUser = (): void => {
    if (userParts.length > 0) items.push({ type: "message", role: "user", content: userParts });
    userParts = [];
  };
  let pending: string[] = [];
  const settlePending = (): void => {
    for (const id of pending) {
      items.push({ type: "function_call_output", call_id: id, output: NO_RESULT_TEXT });
    }
    pending = [];
  };

  for (const m of history) {
    switch (m.role) {
      case "system":
      case "developer":
        settlePending();
        userParts.push({ type: "input_text", text: `[system]\n${textOf(m.content)}` });
        break;
      case "user":
        settlePending();
        userParts.push(...inputParts(toUserBlocks(m.content)));
        break;
      case "tool": {
        const at = pending.indexOf(m.tool_call_id);
        if (at === -1) {
          userParts.push({
            type: "input_text",
            text: `[tool result ${m.tool_call_id}]\n${textOf(m.content)}`,
          });
        } else {
          flushUser();
          pending.splice(at, 1);
          items.push({
            type: "function_call_output",
            call_id: m.tool_call_id,
            output: outputText(m),
          });
        }
        break;
      }
      case "assistant": {
        settlePending();
        flushUser();
        const text = textOf(m.content);
        if (text.length > 0) {
          items.push({
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text }],
          });
        }
        for (const call of m.tool_calls ?? []) {
          items.push({
            type: "function_call",
            name: toolName(call.function.name),
            arguments: call.function.arguments,
            call_id: call.id,
          });
          pending.push(call.id);
        }
        break;
      }
    }
  }
  settlePending();
  flushUser();
  return items;
}
