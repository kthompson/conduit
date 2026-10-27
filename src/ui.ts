import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Config } from "./config.ts";
import { log } from "./log.ts";
import type { ProviderRegistry } from "./providers/registry.ts";
import type { UiMount } from "./server.ts";

const uiRoot = new URL("../ui/", import.meta.url);
const serverEntry = new URL("server/index.ts", uiRoot);
const builtServer = new URL("build/server/index.js", uiRoot);

interface UiModule {
  createUiHandle(options: {
    registry: ProviderRegistry;
    apiKey: string | undefined;
    dev: boolean;
    cspReportOnly: boolean;
    allowedHosts: string[];
  }): Promise<UiMount>;
}

/** Hosts a browser may use to reach this server; anything else is refused (DNS rebinding defense). */
export function allowedHosts(config: Config): string[] {
  const hosts = ["localhost", "127.0.0.1", "[::1]", ...config.ui.allowedHosts];
  const bound = config.server.host;
  if (bound !== "0.0.0.0" && bound !== "::") {
    hosts.push(bound.includes(":") ? `[${bound}]` : bound);
  }
  return [...new Set(hosts.map((h) => h.toLowerCase()))];
}

/** Loads the web UI, or returns undefined (with a log line saying why) when it cannot run. */
export async function loadUi(
  config: Config,
  registry: ProviderRegistry,
): Promise<UiMount | undefined> {
  if (!config.ui.enabled) return undefined;
  if (!existsSync(serverEntry)) {
    log.warn("web UI not found; skipping", { path: fileURLToPath(serverEntry) });
    return undefined;
  }
  if (!config.ui.dev && !existsSync(builtServer)) {
    log.warn("web UI is not built; run `pnpm build:ui`, or start with --ui-dev");
    return undefined;
  }
  try {
    const mod = (await import(serverEntry.href)) as UiModule;
    return await mod.createUiHandle({
      registry,
      apiKey: config.server.apiKey,
      dev: config.ui.dev,
      cspReportOnly: config.ui.cspReportOnly,
      allowedHosts: allowedHosts(config),
    });
  } catch (error) {
    log.error("web UI failed to start; continuing without it", {
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}
