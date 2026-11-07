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
import { doctor } from "./doctor.ts";
import { activeProviders } from "./providers/active.ts";
import { serve } from "./serve.ts";
import { defaultCopilotDb, setupCopilot, type CopilotModel } from "./setup-copilot.ts";

const HELP = `conduit — an OpenAI-compatible endpoint for agent subscriptions

Usage:
  conduit serve    [options]   Serve /v1/chat/completions backed by Claude Code and Codex
  conduit capture  [options]   Serve the mock model and record every exchange
  conduit models   [options]   List the models your logins can use
  conduit doctor   [options]   Check that Claude Code and your Codex logins are installed and logged in
  conduit setup copilot [--write] [--no-efforts] [--no-probe] [--db <file>]
                               Register conduit's models in GitHub Copilot Desktop (dry run without --write)
  conduit init                 Write an example config to ${userConfigPath}

Options:
  -c, --config <file>      Config file (default: ./conduit.toml, then ${userConfigPath})
  -p, --port <n>           Port to listen on
  -H, --host <addr>        Address to bind
      --provider <name>    Default provider: claude, codex or mock (capture defaults to mock)
                           Models are routed to the provider that owns them; this only decides
                           where unrecognized model ids go.
      --capture [dir]      Record requests, responses and upstream events as JSON
      --no-ui              Do not serve the web UI
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
      "no-ui": { type: "boolean" },
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
  if (values["no-ui"]) config.ui.enabled = false;
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

async function setup(
  config: Config,
  values: { write?: boolean; "no-efforts"?: boolean; db?: string; "no-probe"?: boolean },
) {
  const host = config.server.host === "0.0.0.0" ? "127.0.0.1" : config.server.host;
  const baseUrl = `http://${host}:${config.server.port}/v1`;
  const providers = activeProviders(config);
  const listAll = async (): Promise<CopilotModel[]> =>
    (
      await Promise.all(
        providers.map(async (p) =>
          (await p.listModels()).map((m) => ({
            id: m.id,
            displayName: m.displayName,
            contextWindow: m.contextWindow ?? p.settings.contextWindow,
            maxOutputTokens: m.maxOutputTokens,
            efforts: m.supportedEfforts,
          })),
        ),
      )
    ).flat();
  let modelList = await listAll();
  if (!values["no-probe"]) {
    process.stdout.write("Probing each model for its real limits (one tiny turn each)...\n");
    for (const p of providers) {
      for (const m of (await p.listModels()).filter((x) => p.owns(x.id))) {
        const ok = await p.probe(m.id).catch(() => false);
        process.stdout.write(`  ${ok ? "ok  " : "FAIL"} ${m.id}\n`);
      }
    }
    const learned = new Map((await listAll()).map((m) => [m.id, m]));
    modelList = modelList.map((m) => ({
      ...m,
      contextWindow: learned.get(m.id)?.contextWindow ?? m.contextWindow,
      maxOutputTokens: learned.get(m.id)?.maxOutputTokens ?? m.maxOutputTokens,
    }));
  }
  await Promise.all(providers.map((p) => p.close()));
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
  const providers = activeProviders(config);
  for (const p of providers) {
    for (const m of await p.listModels()) {
      process.stdout.write(`${m.id.padEnd(28)} ${(m.displayName ?? "").padEnd(24)} ${p.name}\n`);
    }
  }
  await Promise.all(providers.map((p) => p.close()));
  process.exit(0);
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
