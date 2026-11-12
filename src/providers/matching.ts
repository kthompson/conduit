import { textOf, type ChatMessage } from "../openai/types.ts";
import {
  toToolResultContent,
  toUserBlocks,
  type ToolResultContent,
  type UserBlock,
} from "./conversation.ts";

export type SessionState = "busy" | "awaiting_tools" | "idle" | "closed";

/** The parts of a live session that decide whether a request continues it. */
export interface SessionLike {
  key: string;
  state: SessionState;
  lastUsed: number;
  transcript: readonly string[];
  pendingToolIds: readonly string[];
}

export type Match<S> =
  | { kind: "tools"; session: S; results: Array<{ id: string; content: ToolResultContent[] }> }
  | { kind: "user"; session: S; blocks: UserBlock[] }
  | { kind: "none" };

/**
 * Finds the live session a request continues: its history must extend what
 * the session has seen, followed either by results for the session's pending
 * tool calls or by new user content.
 */
export function matchSession<S extends SessionLike>(
  sessions: Iterable<S>,
  key: string,
  conversation: ChatMessage[],
  prints: string[],
): Match<S> {
  const candidates = [...sessions]
    .filter((s) => s.key === key && (s.state === "idle" || s.state === "awaiting_tools"))
    .toSorted((a, b) => b.lastUsed - a.lastUsed);

  for (const session of candidates) {
    const seen = session.transcript;
    if (prints.length <= seen.length) continue;
    if (!seen.every((p, i) => p === prints[i])) continue;
    const rest = conversation.slice(seen.length);

    if (session.state === "awaiting_tools") {
      const results: Array<{ id: string; content: ToolResultContent[] }> = [];
      let i = 0;
      for (const m of rest) {
        if (m.role !== "tool") break;
        i++;
        results.push({ id: m.tool_call_id, content: toToolResultContent(m.content) });
      }
      if (results.length === 0) continue;
      if (!results.every((r) => session.pendingToolIds.includes(r.id))) continue;
      const after = rest.slice(i);
      if (!after.every(isUserLike)) continue;
      // Content the client adds after tool results rides along with the last result.
      const extra = after.flatMap(userLikeBlocks).map(blockToResult);
      results.at(-1)?.content.push(...extra);
      return { kind: "tools", session, results };
    }

    if (rest.every(isUserLike)) {
      return { kind: "user", session, blocks: rest.flatMap(userLikeBlocks) };
    }
  }
  return { kind: "none" };
}

export function isUserLike(m: ChatMessage): boolean {
  return m.role === "user" || m.role === "system" || m.role === "developer";
}

export function userLikeBlocks(m: ChatMessage): UserBlock[] {
  if (m.role === "user") return toUserBlocks(m.content);
  return [{ type: "text", text: `[system]\n${textOf(m.content)}` }];
}

function blockToResult(block: UserBlock): ToolResultContent {
  if (block.type === "text") return block;
  if (block.source.type === "base64") {
    return { type: "image", data: block.source.data, mimeType: block.source.media_type };
  }
  return { type: "text", text: `[image: ${block.source.url}]` };
}

/**
 * Splits a new session's request into the history to resume as real turns and
 * the trailing user message(s) that start the first turn.
 */
export function coldStart(conversation: ChatMessage[]): {
  history: ChatMessage[];
  blocks: UserBlock[];
} {
  let tail = conversation.length;
  while (tail > 0 && isUserLike(conversation.at(tail - 1) as ChatMessage)) tail--;
  const history = conversation.slice(0, tail);
  const latest = conversation.slice(tail);
  const blocks = latest.flatMap(userLikeBlocks);
  if (blocks.length === 0) blocks.push({ type: "text", text: "Continue." });
  return { history, blocks };
}
