import type { Config, ProviderName } from "./config.ts";
import { log } from "./log.ts";
import { ClaudeProvider } from "./providers/claude/provider.ts";
import { MockProvider } from "./providers/mock/provider.ts";
import { ProviderRegistry } from "./providers/registry.ts";
import { ProviderStore } from "./providers/store.ts";
import type { Provider } from "./providers/types.ts";
import { startServer } from "./server.ts";
import { loadUi } from "./ui.ts";

export async function serve(config: Config) {
  const providers: Partial<Record<ProviderName, Provider>> = { mock: new MockProvider() };
  const registry = new ProviderRegistry(new ProviderStore(), config.claude);
  if (config.defaultProvider === "claude") {
    providers.claude = new ClaudeProvider(config.claude, registry);
  }
  const ui = await loadUi(config, registry);
  const server = await startServer(config, providers, ui);

  log.info(`conduit listening on ${server.url}/v1`, {
    provider: config.defaultProvider,
    config: config.source ?? "(defaults)",
  });
  if (ui) log.info(`web UI at ${server.url}/ui/`);
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
