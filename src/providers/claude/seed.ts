import { randomUUID } from "node:crypto";
import { copyFileSync, mkdtempSync, rmSync, statSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SessionKey, SessionStore, SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk";
import { log } from "../../log.ts";
import { textOf, type ChatMessage } from "../../openai/types.ts";
import { toToolResultContent, toUserBlocks, type UserBlock } from "./conversation.ts";

const SYNTHETIC_RESULT = "The client did not return a result for this tool call.";

type Block = Record<string, unknown>;

function blocksOf(blocks: UserBlock[]): Block[] {
  return blocks.map((b) => ({ ...b }));
}

function toolResultBlock(id: string, content: ChatMessage & { role: "tool" }): Block {
  const parts = toToolResultContent(content.content).map((c) =>
    c.type === "text"
      ? c
      : { type: "image", source: { type: "base64", media_type: c.mimeType, data: c.data } },
  );
  return { type: "tool_result", tool_use_id: id, content: parts };
}

/**
 * Turns an OpenAI-style history into Claude Code transcript entries, so a new
 * session can resume it as real turns. Thinking is not replayed: its
 * signatures cannot be reproduced, and the client's summary is not Claude's.
 *
 * `toolName` maps a client tool name to the name Claude Code sees.
 */
export function buildSeedEntries(input: {
  sessionId: string;
  cwd: string;
  model: string;
  history: ChatMessage[];
  toolName: (clientName: string) => string;
}): SessionStoreEntry[] {
  const { sessionId, cwd, model, history, toolName } = input;
  const entries: SessionStoreEntry[] = [];
  const common = { isSidechain: false, userType: "external", cwd, sessionId };
  let parent: string | null = null;

  const push = (role: "user" | "assistant", content: Block[], extra: Block = {}): void => {
    if (content.length === 0) return;
    const uuid = randomUUID();
    entries.push({
      ...common,
      type: role,
      uuid,
      parentUuid: parent,
      timestamp: new Date().toISOString(),
      message:
        role === "user"
          ? { role, content }
          : {
              id: `msg_${randomUUID().replaceAll("-", "")}`,
              type: "message",
              role,
              model,
              content,
              stop_reason: content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn",
              stop_sequence: null,
              usage: { input_tokens: 0, output_tokens: 0 },
            },
      ...extra,
    });
    parent = uuid;
  };

  // User-like content and tool results share one user entry, as the API requires.
  let userBlocks: Block[] = [];
  const flushUser = (): void => {
    push("user", userBlocks);
    userBlocks = [];
  };
  let pending: string[] = [];
  const settlePending = (): void => {
    for (const id of pending) {
      userBlocks.push({
        type: "tool_result",
        tool_use_id: id,
        is_error: true,
        content: [{ type: "text", text: SYNTHETIC_RESULT }],
      });
    }
    pending = [];
  };

  for (const m of history) {
    switch (m.role) {
      case "system":
      case "developer":
        settlePending();
        userBlocks.push({ type: "text", text: `[system]\n${textOf(m.content)}` });
        break;
      case "user":
        settlePending();
        userBlocks.push(...blocksOf(toUserBlocks(m.content)));
        break;
      case "tool": {
        const at = pending.indexOf(m.tool_call_id);
        if (at === -1) {
          userBlocks.push({
            type: "text",
            text: `[tool result ${m.tool_call_id}]\n${textOf(m.content)}`,
          });
        } else {
          pending.splice(at, 1);
          userBlocks.push(toolResultBlock(m.tool_call_id, m));
        }
        break;
      }
      case "assistant": {
        settlePending();
        flushUser();
        const content: Block[] = [];
        const text = textOf(m.content);
        if (text.length > 0) content.push({ type: "text", text });
        for (const call of m.tool_calls ?? []) {
          content.push({
            type: "tool_use",
            id: call.id,
            name: toolName(call.function.name),
            input: parseArguments(call.function.arguments),
          });
          pending.push(call.id);
        }
        push("assistant", content);
        break;
      }
    }
  }
  settlePending();
  flushUser();
  return entries;
}

function parseArguments(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Fall through: malformed arguments become an empty call.
  }
  return {};
}

/** A read-only store that holds one seeded session; nothing is persisted. */
export class SeedStore implements SessionStore {
  private readonly sessionId: string;
  private readonly entries: SessionStoreEntry[];

  constructor(sessionId: string, entries: SessionStoreEntry[]) {
    this.sessionId = sessionId;
    this.entries = entries;
  }

  async append(): Promise<void> {}

  // The project key is derived by the SDK from the cwd; only the session id matters here.
  async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
    return key.sessionId === this.sessionId && key.subpath === undefined ? this.entries : null;
  }
}

/**
 * Scratch config dir for a resumed process. Claude Code only mirrors a session
 * store through local writes, so these go to a throwaway dir (with the login
 * linked in) instead of ~/.claude. Returns the dir and a function that removes it.
 */
export function scratchConfigDir(configured: string | undefined): {
  dir: string;
  remove: () => void;
} {
  const source = configured ?? process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
  const dir = mkdtempSync(path.join(os.tmpdir(), "conduit-claude-"));
  const from = path.join(source, ".credentials.json");
  const to = path.join(dir, ".credentials.json");
  let copied = false;
  try {
    try {
      symlinkSync(from, to);
    } catch (error) {
      // Windows forbids symlinks without developer mode or elevation.
      if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
      copyFileSync(from, to);
      copied = true;
    }
  } catch (error) {
    log.warn("could not link Claude credentials into the scratch config dir", {
      error: String(error),
    });
  }
  return {
    dir,
    remove: () => {
      // Refresh tokens rotate, so a refresh inside the scratch dir invalidates
      // the one in the real file; carry the newer file back.
      if (copied) {
        try {
          if (statSync(to).mtimeMs > statSync(from).mtimeMs) copyFileSync(to, from);
        } catch {}
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
