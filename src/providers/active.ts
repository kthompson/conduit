import type { Config } from "../config.ts";
import { ClaudeProvider } from "./claude/provider.ts";
import { CodexProvider } from "./codex/provider.ts";
import { ProviderRegistry } from "./registry.ts";
import { ProviderStore } from "./store.ts";

/** The providers a one-shot command talks to. Codex lists models only once a Codex login is added. */
export function activeProviders(config: Config): Array<ClaudeProvider | CodexProvider> {
  const registry = new ProviderRegistry(new ProviderStore(), config);
  return [new ClaudeProvider(config.claude, registry), new CodexProvider(config.codex, registry)];
}
