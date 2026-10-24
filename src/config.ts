import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parse } from "smol-toml";

export type ProviderName = "claude" | "mock";
export type ReasoningOutput = "reasoning_content" | "think_tags" | "none";

export interface ServerConfig {
  host: string;
  port: number;
  /** When set, clients must send `Authorization: Bearer <api_key>` (or `x-api-key`). */
  apiKey: string | undefined;
}

export interface CaptureConfig {
  enabled: boolean;
  dir: string;
}

export interface ClaudeConfig {
  /** Path to a `claude` binary. Unset uses the binary bundled with the Agent SDK. */
  binary: string | undefined;
  /** Working directory for the Claude Code process. */
  cwd: string;
  /** Claude Code settings layers to load. Empty keeps the model isolated from user/project config. */
  settingSources: Array<"user" | "project" | "local">;
  /** Drop ANTHROPIC_API_KEY from the child env so Claude Code uses the subscription login. */
  stripApiKey: boolean;
  /** Seconds a live session may sit unused before its process is closed. */
  sessionIdleSeconds: number;
  /** Maximum live sessions (Claude Code processes) kept at once. */
  maxSessions: number;
  /** Seconds Claude waits for the client to return a tool result. */
  toolTimeoutSeconds: number;
  /** Default effort when the request does not carry `reasoning_effort`. */
  effort: string | undefined;
  /** Context window (tokens) advertised in /v1/models for Claude models. */
  contextWindow: number | undefined;
  /** How Claude's thinking is surfaced in chat completion output. */
  reasoning: ReasoningOutput;
  /** Extra environment variables for the Claude Code process. */
  env: Record<string, string>;
}

export interface ModelRoute {
  provider: ProviderName;
  /** Model id passed to the provider; defaults to the exposed id. */
  upstream: string | undefined;
  effort: string | undefined;
  /** Context window reported in /v1/models so clients size compaction correctly. */
  contextWindow: number | undefined;
}

export interface Config {
  server: ServerConfig;
  capture: CaptureConfig;
  defaultProvider: ProviderName;
  claude: ClaudeConfig;
  /** Explicit model routes keyed by the id clients send. */
  models: Record<string, ModelRoute>;
  /** File the config was read from, if any. */
  source: string | undefined;
}

export const stateDir = path.join(
  process.env.XDG_STATE_HOME ?? path.join(homedir(), ".local", "state"),
  "conduit",
);

export const userConfigPath = path.join(
  process.env.XDG_CONFIG_HOME ?? path.join(homedir(), ".config"),
  "conduit",
  "config.toml",
);

export function defaultConfig(): Config {
  return {
    server: { host: "127.0.0.1", port: 4100, apiKey: undefined },
    capture: { enabled: false, dir: path.join(stateDir, "captures") },
    defaultProvider: "claude",
    claude: {
      binary: undefined,
      cwd: process.cwd(),
      settingSources: [],
      stripApiKey: true,
      sessionIdleSeconds: 900,
      maxSessions: 8,
      toolTimeoutSeconds: 3600,
      effort: undefined,
      contextWindow: 200_000,
      reasoning: "reasoning_content",
      env: {},
    },
    models: {},
    source: undefined,
  };
}

/** Resolution order: explicit path, $CONDUIT_CONFIG, ./conduit.toml, ~/.config/conduit/config.toml. */
export function findConfigFile(explicit?: string): string | undefined {
  if (explicit) return explicit;
  const candidates = [
    process.env.CONDUIT_CONFIG,
    path.resolve("conduit.toml"),
    userConfigPath,
  ].filter((p): p is string => typeof p === "string" && p.length > 0);
  return candidates.find((p) => existsSync(p));
}

export function loadConfig(explicit?: string): Config {
  const config = defaultConfig();
  const file = findConfigFile(explicit);
  if (file === undefined) return config;
  const raw = parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  applyToml(config, raw, file);
  config.source = file;
  return config;
}

export function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") ? path.join(homedir(), p.slice(1)) : p;
}

function applyToml(config: Config, raw: Record<string, unknown>, file: string): void {
  const where = (key: string) => `${file}: ${key}`;
  const server = table(raw.server, where("server"));
  if (server) {
    config.server.host = str(server.host, where("server.host")) ?? config.server.host;
    config.server.port = num(server.port, where("server.port")) ?? config.server.port;
    config.server.apiKey = nonEmpty(str(server.api_key, where("server.api_key")));
  }

  const capture = table(raw.capture, where("capture"));
  if (capture) {
    config.capture.enabled = bool(capture.enabled, where("capture.enabled")) ?? false;
    const dir = str(capture.dir, where("capture.dir"));
    if (dir) config.capture.dir = path.resolve(expandHome(dir));
  }

  const provider = str(raw.default_provider, where("default_provider"));
  if (provider) config.defaultProvider = providerName(provider, where("default_provider"));

  const claude = table(table(raw.providers, where("providers"))?.claude, where("providers.claude"));
  if (claude) {
    const c = config.claude;
    const binary = nonEmpty(str(claude.binary, where("providers.claude.binary")));
    c.binary = binary === undefined ? undefined : expandHome(binary);
    const cwd = nonEmpty(str(claude.cwd, where("providers.claude.cwd")));
    if (cwd) c.cwd = path.resolve(expandHome(cwd));
    if (claude.setting_sources !== undefined) {
      const sources = strList(claude.setting_sources, where("providers.claude.setting_sources"));
      for (const s of sources) {
        if (s !== "user" && s !== "project" && s !== "local") {
          throw new Error(`${where("providers.claude.setting_sources")}: unknown source "${s}"`);
        }
      }
      c.settingSources = sources as ClaudeConfig["settingSources"];
    }
    c.stripApiKey =
      bool(claude.strip_api_key, where("providers.claude.strip_api_key")) ?? c.stripApiKey;
    c.sessionIdleSeconds =
      num(claude.session_idle_seconds, where("providers.claude.session_idle_seconds")) ??
      c.sessionIdleSeconds;
    c.maxSessions =
      num(claude.max_sessions, where("providers.claude.max_sessions")) ?? c.maxSessions;
    c.toolTimeoutSeconds =
      num(claude.tool_timeout_seconds, where("providers.claude.tool_timeout_seconds")) ??
      c.toolTimeoutSeconds;
    c.effort = nonEmpty(str(claude.effort, where("providers.claude.effort")));
    c.contextWindow =
      num(claude.context_window, where("providers.claude.context_window")) ?? c.contextWindow;
    const reasoning = str(claude.reasoning, where("providers.claude.reasoning"));
    if (reasoning !== undefined) {
      if (reasoning !== "reasoning_content" && reasoning !== "think_tags" && reasoning !== "none") {
        throw new Error(
          `${where("providers.claude.reasoning")}: expected reasoning_content, think_tags or none`,
        );
      }
      c.reasoning = reasoning;
    }
    const env = table(claude.env, where("providers.claude.env"));
    if (env) {
      for (const [k, v] of Object.entries(env)) c.env[k] = String(v);
    }
  }

  const models = table(raw.models, where("models"));
  if (models) {
    for (const [id, value] of Object.entries(models)) {
      const m = table(value, where(`models.${id}`)) ?? {};
      config.models[id] = {
        provider: providerName(
          str(m.provider, where(`models.${id}.provider`)) ?? config.defaultProvider,
          where(`models.${id}.provider`),
        ),
        upstream: nonEmpty(str(m.upstream, where(`models.${id}.upstream`))),
        effort: nonEmpty(str(m.effort, where(`models.${id}.effort`))),
        contextWindow: num(m.context_window, where(`models.${id}.context_window`)),
      };
    }
  }
}

function providerName(value: string, where: string): ProviderName {
  if (value === "claude" || value === "mock") return value;
  throw new Error(`${where}: unknown provider "${value}" (expected claude or mock)`);
}

function table(value: unknown, where: string): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${where}: expected a table`);
  }
  return value as Record<string, unknown>;
}

function str(value: unknown, where: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${where}: expected a string`);
  return value;
}

function num(value: unknown, where: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`${where}: expected a number`);
  return value;
}

function bool(value: unknown, where: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${where}: expected true or false`);
  return value;
}

function strList(value: unknown, where: string): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new Error(`${where}: expected an array of strings`);
  }
  return value as string[];
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value.trim().length === 0 ? undefined : value.trim();
}
