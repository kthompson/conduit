import type { CodexConfig, Config } from "./config.ts";
import { openProbe } from "./providers/claude/probe.ts";
import { fetchCodexModels } from "./providers/codex/models.ts";
import { fetchCodexUsage } from "./providers/codex/usage.ts";
import { ProviderRegistry } from "./providers/registry.ts";
import { ProviderStore } from "./providers/store.ts";

const ok = (msg: string) => process.stdout.write(`  ok    ${msg}\n`);
const bad = (msg: string) => process.stdout.write(`  FAIL  ${msg}\n`);

/** Checks each enabled provider is installed, logged in and can list its models. */
export async function doctor(config: Config) {
  process.stdout.write(`conduit doctor\n`);
  process.stdout.write(`  config: ${config.source ?? "(none, using defaults)"}\n`);
  await doctorClaude(config);
  const registry = new ProviderRegistry(new ProviderStore(), config);
  const logins = registry.store.enabled("codex");
  if (logins.length === 0) {
    process.stdout.write(
      "  note  No Codex login yet; add one in the web UI (Providers, Add provider) to serve GPT models\n",
    );
  }
  for (const login of logins) {
    process.stdout.write(`  Codex login "${login.name}"\n`);
    await doctorCodex(registry.codexConfig(login));
  }
  process.exit();
}

async function doctorClaude(config: Config) {
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
}

async function doctorCodex(config: CodexConfig) {
  if (process.env.OPENAI_API_KEY) {
    process.stdout.write(
      config.stripApiKey
        ? "  note  OPENAI_API_KEY is set; conduit removes it so Codex uses your ChatGPT login\n"
        : "  note  OPENAI_API_KEY is set and strip_api_key=false; usage bills the API key\n",
    );
  }
  const usage = await fetchCodexUsage(config);
  if (usage.account === undefined) {
    bad(`could not talk to Codex: ${usage.error ?? "no account reported"}`);
    process.stdout.write("        Run `codex login` once, or set providers.codex.binary.\n");
    process.exitCode = 1;
    return;
  }
  ok(`Codex reachable; auth: ${usage.account.auth}`);
  try {
    const list = await fetchCodexModels(config);
    ok(`models: ${list.map((m) => m.model).join(", ")}`);
  } catch (error) {
    bad(`could not list Codex models: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
