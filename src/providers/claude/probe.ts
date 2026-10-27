import { query, type ModelInfo, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { Channel } from "../../channel.ts";
import type { ClaudeConfig } from "../../config.ts";

/** Asks a short-lived Claude Code process which models this login can use. */
export async function probeModels(config: ClaudeConfig): Promise<ModelInfo[]> {
  const q = openProbe(config);
  try {
    return await q.supportedModels();
  } finally {
    q.close();
  }
}

/**
 * A Claude Code process with no conversation, for asking about the account.
 * `keepOpen` leaves the input stream open so control requests issued after the
 * first one are still answered; closing the query ends it either way.
 */
export function openProbe(config: ClaudeConfig, options: { keepOpen?: boolean } = {}) {
  const env: Record<string, string | undefined> = { ...process.env, ...config.env };
  if (config.stripApiKey) delete env.ANTHROPIC_API_KEY;
  return query({
    prompt: options.keepOpen ? new Channel<SDKUserMessage>() : (async function* () {})(),
    options: {
      tools: [],
      settingSources: [],
      persistSession: false,
      cwd: config.cwd,
      env,
      ...(config.binary === undefined ? {} : { pathToClaudeCodeExecutable: config.binary }),
    },
  });
}
