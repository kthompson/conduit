import { createContext } from "react-router";
import type { ProviderRegistry } from "../../src/providers/registry.ts";

/** What conduit hands the UI for every request. */
export interface ConduitContext {
  registry: ProviderRegistry;
  /** When set, the UI asks for it once and remembers the browser with a signed cookie. */
  apiKey: string | undefined;
  /** Vite dev server in use: relaxes CSP for HMR. */
  dev: boolean;
  cspReportOnly: boolean;
}

export const conduitContext = createContext<ConduitContext>();
