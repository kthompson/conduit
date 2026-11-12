import type { EffortLevel, Options } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeConfig } from "../../config.ts";
import { log } from "../../log.ts";
import type { SessionSpec } from "../session.ts";
import { buildSeedEntries, scratchConfigDir, SeedStore } from "./seed.ts";
import { BRIDGE_SERVER, type ToolBridge } from "./toolBridge.ts";

const DEFAULT_SYSTEM_PROMPT = "You are a helpful assistant.";
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

export interface SessionOptions extends SessionSpec {
  config: ClaudeConfig;
  /** Receives the real context window and output cap Claude Code reports after a turn. */
  onLimits?: (model: string, limits: { contextWindow: number; maxOutputTokens: number }) => void;
}

/**
 * Options that resume `history` as real turns instead of starting empty, plus
 * a function that removes the scratch config dir the resumed session runs in.
 */
export function resumeOptions(
  options: SessionOptions,
  bridge: ToolBridge,
): { options: Partial<Options>; cleanup: (() => void) | undefined } {
  if (!options.history || options.history.length === 0) return { options: {}, cleanup: undefined };
  const sessionId = crypto.randomUUID();
  const entries = buildSeedEntries({
    sessionId,
    cwd: options.config.cwd,
    model: options.model,
    history: options.history,
    toolName: (name) => bridge.claudeName(name),
  });
  const scratch = scratchConfigDir(options.config.env.CLAUDE_CONFIG_DIR);
  return {
    cleanup: scratch.remove,
    options: {
      resume: sessionId,
      sessionStore: new SeedStore(sessionId, entries),
      persistSession: true,
      env: { ...buildEnv(options.config), CLAUDE_CONFIG_DIR: scratch.dir },
    },
  };
}

export function buildEnv(config: ClaudeConfig): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    ...config.env,
    CLAUDE_AGENT_SDK_CLIENT_APP: "conduit/0.1.0",
  };
  if (config.stripApiKey) delete env.ANTHROPIC_API_KEY;
  return env;
}

export function buildOptions(options: SessionOptions, bridge: ToolBridge): Options {
  const { config } = options;
  const env = buildEnv(config);

  let effort: EffortLevel | undefined;
  if (options.effort !== undefined) {
    if (EFFORTS.has(options.effort)) effort = options.effort as EffortLevel;
    else log.warn("ignoring unknown effort", { effort: options.effort });
  }

  return {
    model: options.model,
    systemPrompt: options.system.trim().length > 0 ? options.system : DEFAULT_SYSTEM_PROMPT,
    // Claude acts as a model here: the client owns and runs every tool.
    tools: [],
    ...(options.tools.length > 0
      ? {
          mcpServers: {
            [BRIDGE_SERVER]: {
              type: "sdk" as const,
              name: BRIDGE_SERVER,
              instance: bridge.server,
              timeout: config.toolTimeoutSeconds * 1000,
            },
          },
        }
      : {}),
    strictMcpConfig: true,
    settingSources: config.settingSources,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    persistSession: false,
    includePartialMessages: true,
    cwd: config.cwd,
    env,
    ...(effort === undefined ? {} : { effort }),
    ...(config.reasoning === "none"
      ? {}
      : { thinking: { type: "adaptive", display: "summarized" } }),
    ...(config.binary === undefined ? {} : { pathToClaudeCodeExecutable: config.binary }),
    stderr: (data) => log.debug("claude stderr", { data: data.trimEnd() }),
  };
}
