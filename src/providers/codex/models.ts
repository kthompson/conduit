import type { CodexConfig } from "../../config.ts";
import { queryCodex } from "./appServer.ts";

export interface CodexModelInfo {
  model: string;
  displayName: string;
  hidden: boolean;
  supportedReasoningEfforts: Array<{ reasoningEffort: string }>;
}

interface ModelListResponse {
  data: CodexModelInfo[];
  nextCursor: string | null;
}

/** Asks a short-lived Codex process which models this login can use. */
export function fetchCodexModels(config: CodexConfig): Promise<CodexModelInfo[]> {
  return queryCodex(config, async (client) => {
    const models: CodexModelInfo[] = [];
    let cursor: string | null = null;
    do {
      const page: ModelListResponse = await client.request<ModelListResponse>("model/list", {
        cursor,
      });
      models.push(...page.data);
      cursor = page.nextCursor;
    } while (cursor !== null);
    return models;
  });
}
