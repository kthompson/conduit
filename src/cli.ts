import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  loadConfig,
  userConfigPath,
  expandHome,
  type Config,
  type ProviderName,
} from "./config.ts";
import { log, setLogLevel } from "./log.ts";
import { ClaudeProvider, openProbe } from "./providers/claude/provider.ts";
import { MockProvider } from "./providers/mock/provider.ts";
import type { Provider } from "./providers/types.ts";
import { startServer } from "./server.ts";
import { defaultCopilotDb, setupCopilot, type CopilotModel } from "./setup-copilot.ts";

const HELP = `conduit — an OpenAI-compatible endpoint for agent subscriptions

Usage:
  conduit serve    [options]   Serve /v1/chat/completions backed by Claude Code
  conduit capture  [options]   Serve the mock model and record every exchange
  conduit models   [options]   List the models your Claude login can use
  conduit doctor   [options]   Check that Claude Code is installed and logged in
  conduit setup copilot [--write] [--no-efforts] [--no-probe] [--db <file>]
                               Register conduit's models in GitHub Copilot Desktop (dry run without --write)
  conduit init                 Write an example config to ${userConfigPath}

Options:
  -c, --config <file>      Config file (default: ./conduit.toml, then ${userConfigPath})
  -p, --port <n>           Port to listen on
  -H, --host <addr>        Address to bind
      --provider <name>    Default provider: claude or mock (capture defaults to mock)
      --capture [dir]      Record requests, responses and upstream events as JSON
  -v, --verbose            Debug logging
  -h, --help               Show this help
`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: "string", short: "c" },
      port: { type: "string", short: "p" },
      host: { type: "string", short: "H" },
      provider: { type: "string" },
      capture: { type: "string" },
      verbose: { type: "boolean", short: "v" },
      help: { type: "boolean", short: "h" },
      write: { type: "boolean" },
      efforts: { type: "boolean" }, // accepted for older scripts; efforts are written by default now
      "no-efforts": { type: "boolean" },
      db: { type: "string" },
      "no-probe": { type: "boolean" },
    },
    // `--capture` may be given without a directory.
    args: process.argv
      .slice(2)
      .flatMap((a, i, all) =>
        a === "--capture" && (all[i + 1]?.startsWith("-") ?? true) ? ["--capture", ""] : [a],
      ),
  });
  const command = positionals[0] ?? "serve";
  if (values.help || command === "help") return void process.stdout.write(HELP);
  if (values.verbose) setLogLevel("debug");

  if (command === "init") return init();

  const config = loadConfig(values.config);
  if (values.port) config.server.port = Number(values.port);
  if (values.host) config.server.host = values.host;
  if (values.provider) config.defaultProvider = values.provider as ProviderName;
  if (values.capture !== undefined) {
    config.capture.enabled = true;
    if (values.capture.length > 0) config.capture.dir = path.resolve(expandHome(values.capture));
  }

  switch (command) {
    case "serve":
      return serve(config);
    case "capture":
      config.capture.enabled = true;
      if (!values.provider) config.defaultProvider = "mock";
      return serve(config);
    case "models":
      return models(config);
    case "doctor":
      return doctor(config);
    case "setup":
      if (positionals[1] !== "copilot") {
        process.stderr.write(`Usage: conduit setup copilot\n`);
        process.exitCode = 2;
        return;
      }
      return setup(config, values);
    default:
      process.stderr.write(`Unknown command "${command}".\n\n${HELP}`);
      process.exitCode = 2;
  }
}

async function serve(config: Config) {
  const providers: Partial<Record<ProviderName, Provider>> = { mock: new MockProvider() };
  if (config.defaultProvider === "claude") {
    providers.claude = new ClaudeProvider(config.claude);
  }
  const server = await startServer(config, providers);

  log.info(`conduit listening on ${server.url}/v1`, {
    provider: config.defaultProvider,
    config: config.source ?? "(defaults)",
  });
  if (server.recorder.dir) log.info(`capturing to ${server.recorder.dir}`);
  if (
    config.server.host !== "127.0.0.1" &&
    config.server.host !== "localhost" &&
    !config.server.apiKey
  ) {
    log.warn(
      "listening beyond localhost without server.api_key; anyone who can reach this port can use your subscription",
    );
  }

  let stopping = false;
  const stop = async () => {
    if (stopping) return process.exit(1);
    stopping = true;
    log.info("shutting down");
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
}

async function setup(
  config: Config,
  values: { write?: boolean; "no-efforts"?: boolean; db?: string; "no-probe"?: boolean },
) {
  const host = config.server.host === "0.0.0.0" ? "127.0.0.1" : config.server.host;
  const baseUrl = `http://${host}:${config.server.port}/v1`;
  const claude = new ClaudeProvider(config.claude);
  let modelList: CopilotModel[] = (await claude.listModels()).map((m) => ({
    id: m.id,
    displayName: m.displayName,
    contextWindow: m.contextWindow ?? config.claude.contextWindow,
    maxOutputTokens: m.maxOutputTokens,
    efforts: m.supportedEfforts,
  }));
  if (!values["no-probe"]) {
    process.stdout.write("Probing each model for its real limits (one tiny turn each)...\n");
    for (const m of modelList) {
      const ok = await claude.probe(m.id).catch(() => false);
      process.stdout.write(`  ${ok ? "ok  " : "FAIL"} ${m.id}\n`);
    }
    const learned = new Map((await claude.listModels()).map((m) => [m.id, m]));
    modelList = modelList.map((m) => ({
      ...m,
      contextWindow: learned.get(m.id)?.contextWindow ?? m.contextWindow,
      maxOutputTokens: learned.get(m.id)?.maxOutputTokens ?? m.maxOutputTokens,
    }));
  }
  await claude.close();
  const lines = setupCopilot({
    dbPath: values.db ?? defaultCopilotDb,
    baseUrl,
    models: modelList,
    write: values.write === true,
    efforts: values["no-efforts"] !== true,
  });
  process.stdout.write(lines.join("\n") + "\n");
  process.exit(0);
}

async function models(config: Config) {
  const list = await new ClaudeProvider(config.claude).listModels();
  for (const m of list) process.stdout.write(`${m.id.padEnd(28)} ${m.displayName ?? ""}\n`);
  process.exit(0);
}

const ok = (msg: string) => process.stdout.write(`  ok    ${msg}\n`);
const bad = (msg: string) => process.stdout.write(`  FAIL  ${msg}\n`);

async function doctor(config: Config) {
  process.stdout.write(`conduit doctor\n`);
  process.stdout.write(`  config: ${config.source ?? "(none, using defaults)"}\n`);
  if (process.env.ANTHROPIC_API_KEY) {
    process.stdout.write(
      config.claude.stripApiKey
        ? "  note  ANTHROPIC_API_KEY is set; conduit removes it so Claude Code uses your subscription\n"
        : "  note  ANTHROPIC_API_KEY is set and strip_api_key=false; usage bills the API key\n",
    );
  }
  const q = openProbe(config.claude);
  try {
    const account = await q.accountInfo();
    const usesKey = account.apiKeySource !== undefined && account.apiKeySource !== "none";
    const auth = usesKey
      ? `API key (${account.apiKeySource}), billed to the API`
      : account.subscriptionType
        ? `subscription login (${account.subscriptionType})`
        : `login (${account.tokenSource ?? "source unknown"})`;
    ok(`Claude Code reachable; auth: ${auth}`);
    const list = await q.supportedModels();
    ok(
      `models: ${list
        .filter((m) => m.value !== "default")
        .map((m) => m.resolvedModel ?? m.value)
        .join(", ")}`,
    );
  } catch (error) {
    bad(`could not talk to Claude Code: ${error instanceof Error ? error.message : String(error)}`);
    process.stdout.write("        Run `claude` once and log in, or set providers.claude.binary.\n");
    process.exitCode = 1;
  } finally {
    q.close();
  }
  process.exit();
}

function init() {
  const example = new URL("../conduit.example.toml", import.meta.url);
  if (existsSync(userConfigPath)) {
    process.stdout.write(`${userConfigPath} already exists; leaving it alone.\n`);
    return;
  }
  mkdirSync(path.dirname(userConfigPath), { recursive: true });
  copyFileSync(example, userConfigPath);
  process.stdout.write(`Wrote ${userConfigPath}\n`);
}

main().catch((error) => {
  log.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
