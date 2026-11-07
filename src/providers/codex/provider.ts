import { Trace, type TraceRecord } from "../../capture/recorder.ts";
import type { CodexConfig } from "../../config.ts";
import { log } from "../../log.ts";
import { ConversationProvider, type NewSessionArgs } from "../conversationProvider.ts";
import type { ProviderRegistry } from "../registry.ts";
import type { ModelEntry, ProviderSettings } from "../types.ts";
import { fetchCodexModels, type CodexModelInfo } from "./models.ts";
import { CodexSession } from "./session.ts";

const MODEL_CACHE_MS = 10 * 60 * 1000;
/** After a failed listing, wait this long before spawning Codex again just to ask. */
const FAILURE_CACHE_MS = 60 * 1000;
/** Ids Codex serves: the GPT and o-series families and Codex-branded models. */
const CODEX_MODEL = /^(gpt-|o\d|codex)/i;

export class CodexProvider extends ConversationProvider<CodexSession> {
  readonly name = "codex";
  protected readonly type = "codex" as const;
  protected readonly agent: CodexConfig;
  readonly settings: ProviderSettings;
  private readonly contextWindows = new Map<string, number>();
  private models: { until: number; list: CodexModelInfo[] } | undefined;

  /** With a registry, new conversations are routed across its logins by priority. */
  constructor(config: CodexConfig, registry?: ProviderRegistry) {
    super(registry);
    this.agent = config;
    this.settings = {
      effort: config.effort,
      reasoning: config.reasoning,
      contextWindow: config.contextWindow,
    };
  }

  owns(model: string): boolean {
    return CODEX_MODEL.test(model) || (this.models?.list.some((m) => m.model === model) ?? false);
  }

  async listModels(): Promise<ModelEntry[]> {
    const out: ModelEntry[] = [];
    for (const m of await this.supportedModels()) {
      if (m.hidden) continue;
      const entry: ModelEntry = {
        id: m.model,
        ownedBy: "openai",
        displayName: m.displayName,
        supportedEfforts: m.supportedReasoningEfforts.map((e) => e.reasoningEffort),
      };
      const contextWindow = this.contextWindows.get(m.model);
      if (contextWindow !== undefined) entry.contextWindow = contextWindow;
      out.push(entry);
    }
    return out;
  }

  /** Runs one tiny turn so Codex reports this model's real context window; it then shows up in listModels(). */
  async probe(model: string): Promise<boolean> {
    const trace = new Trace(false, {} as TraceRecord, undefined);
    let failed = false;
    for await (const event of this.turn({
      request: {
        model,
        messages: [{ role: "user", content: "Reply with the single word: ok" }],
      },
      upstreamModel: model,
      effort: undefined,
      signal: AbortSignal.timeout(90_000),
      trace,
    })) {
      if (event.type === "error") failed = true;
    }
    return !failed;
  }

  protected createSession(args: NewSessionArgs<CodexSession>): CodexSession {
    const config = args.entry && this.registry ? this.registry.codexConfig(args.entry) : this.agent;
    return new CodexSession(
      {
        key: args.key,
        providerId: args.providerId,
        model: args.model,
        effort: this.usableEffort(args.model, args.effort),
        system: args.system,
        tools: args.tools,
        history: args.history,
        config,
        onContextWindow: (model, window) => this.contextWindows.set(model, window),
      },
      args.onClose,
    );
  }

  /** Drops an effort the model is known not to support, rather than failing the request. */
  private usableEffort(model: string, effort: string | undefined): string | undefined {
    if (effort === undefined) return undefined;
    const info = this.models?.list.find((m) => m.model === model);
    if (!info) return effort;
    if (info.supportedReasoningEfforts.some((e) => e.reasoningEffort === effort)) return effort;
    log.warn("ignoring effort the model does not support", { model, effort });
    return undefined;
  }

  /** Models come from the highest-priority enabled login. */
  private modelsConfig(): CodexConfig {
    const first = this.registry?.store.enabled("codex")[0];
    return first && this.registry ? this.registry.codexConfig(first) : this.agent;
  }

  private async supportedModels(): Promise<CodexModelInfo[]> {
    // No Codex login yet means no Codex process: there is nothing to ask and nothing to start.
    if (this.registry && this.registry.store.enabled("codex").length === 0) return [];
    const cached = this.models;
    if (cached && Date.now() < cached.until) return cached.list;
    try {
      const list = await fetchCodexModels(this.modelsConfig());
      this.models = { until: Date.now() + MODEL_CACHE_MS, list };
      return list;
    } catch (error) {
      log.warn("could not list Codex models", { error: String(error) });
      this.models = { until: Date.now() + FAILURE_CACHE_MS, list: cached?.list ?? [] };
      return this.models.list;
    }
  }
}
