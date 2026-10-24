export interface ModelLimits {
  contextWindow: number;
  maxOutputTokens: number;
}

const K = 1_000;
const M = 1_000_000;

/**
 * Limits Claude Code enforces, read from `modelUsage.contextWindow` and
 * `maxOutputTokens` in the Agent SDK's result message on a Claude Pro login
 * (2026-10-23). These can differ from the API docs: the docs list 1M for Opus
 * 4.6 and Sonnet 4.6, and 128K output for Fable 5.1, but Claude Code gave 200K
 * for the former (1M only with the `[1m]` suffix) and 64K for the latter.
 *
 * This is the fallback. A running server learns the real numbers for the
 * current login from live turns, and those take precedence.
 */
const KNOWN: Record<string, ModelLimits> = {
  "claude-opus-5-5": { contextWindow: 1 * M, maxOutputTokens: 128 * K },
  "claude-sonnet-5-5": { contextWindow: 1 * M, maxOutputTokens: 128 * K },
  "claude-haiku-5-5": { contextWindow: 1 * M, maxOutputTokens: 128 * K },
  "claude-fable-5-1": { contextWindow: 1 * M, maxOutputTokens: 64 * K },
  "claude-opus-5": { contextWindow: 1 * M, maxOutputTokens: 64 * K },
  "claude-sonnet-5": { contextWindow: 1 * M, maxOutputTokens: 64 * K },
  "claude-fable-5": { contextWindow: 1 * M, maxOutputTokens: 64 * K },
  "claude-opus-4-8": { contextWindow: 1 * M, maxOutputTokens: 64 * K },
  "claude-opus-4-7": { contextWindow: 1 * M, maxOutputTokens: 64 * K },
  "claude-opus-4-6": { contextWindow: 200 * K, maxOutputTokens: 64 * K },
  "claude-sonnet-4-6": { contextWindow: 200 * K, maxOutputTokens: 32 * K },
  "claude-haiku-4-5-20251001": { contextWindow: 200 * K, maxOutputTokens: 32 * K },
};

/** Known limits for a full model id. A `[1m]` suffix lifts the window to 1M, as in Claude Code. */
export function knownLimits(model: string): ModelLimits | undefined {
  const oneMillion = model.endsWith("[1m]");
  const base = KNOWN[oneMillion ? model.slice(0, -"[1m]".length) : model];
  if (!base) return undefined;
  return oneMillion ? { ...base, contextWindow: Math.max(base.contextWindow, 1 * M) } : base;
}
