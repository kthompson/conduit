import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeConfig } from "../../config.ts";
import { Trace, type TraceRecord } from "../../capture/recorder.ts";
import { log } from "../../log.ts";
import { ConversationProvider, type NewSessionArgs } from "../conversationProvider.ts";
import type { ProviderRegistry } from "../registry.ts";
import type { ModelEntry, ProviderSettings } from "../types.ts";
import { knownLimits } from "./limits.ts";
import { probeModels } from "./probe.ts";
import { ClaudeSession } from "./session.ts";

const MODEL_CACHE_MS = 10 * 60 * 1000;
const FALLBACK_MODELS = ["opus", "sonnet", "haiku"];
/** Ids and aliases Claude Code accepts. */
const CLAUDE_MODEL = /^(claude-|opus|sonnet|haiku|fable)/;

export class ClaudeProvider extends ConversationProvider<ClaudeSession> {
  readonly name = "claude";
  protected readonly type = "claude" as const;
  protected readonly agent: ClaudeConfig;
  readonly settings: ProviderSettings;
  private readonly limits = new Map<string, { contextWindow: number; maxOutputTokens: number }>();
  private models: { at: number; list: ModelInfo[] } | undefined;

  /** With a registry, new conversations are routed across its providers by priority. */
  constructor(config: ClaudeConfig, registry?: ProviderRegistry) {
    super(registry);
    this.agent = config;
    this.settings = {
      effort: config.effort,
      reasoning: config.reasoning,
      contextWindow: config.contextWindow,
    };
  }

  owns(model: string): boolean {
    return CLAUDE_MODEL.test(model);
  }

  /** Matches usage keys like "claude-opus-4-5-20251101" or "claude-opus-4-5[1m]" to the ids we list. */
  recordLimits(model: string, limits: { contextWindow: number; maxOutputTokens: number }): void {
    this.limits.set(model, limits);
    this.limits.set(model.replace(/\[.*\]$/, ""), limits);
  }

  async listModels(): Promise<ModelEntry[]> {
    const infos = await this.supportedModels();
    const seen = new Set<string>();
    const out: ModelEntry[] = [];
    for (const info of infos) {
      if (info.value === "default") continue;
      const id = info.resolvedModel ?? info.value;
      if (seen.has(id)) continue;
      seen.add(id);
      const learned = this.limits.get(id) ?? this.limits.get(info.value) ?? knownLimits(id);
      out.push({
        id,
        ...learned,
        ownedBy: "anthropic",
        displayName: info.displayName,
        ...(info.supportsEffort && info.supportedEffortLevels
          ? { supportedEfforts: info.supportedEffortLevels }
          : {}),
      });
    }
    return out;
  }

  /** Runs one tiny turn so Claude Code reports this model's real limits; they then show up in listModels(). */
  async probe(model: string): Promise<boolean> {
    const trace = new Trace(false, {} as TraceRecord, undefined);
    const request = {
      model,
      messages: [{ role: "user" as const, content: "Reply with the single word: ok" }],
    };
    let failed = false;
    for await (const event of this.turn({
      request,
      upstreamModel: model,
      effort: undefined,
      signal: AbortSignal.timeout(90_000),
      trace,
    })) {
      if (event.type === "error") failed = true;
    }
    return !failed;
  }

  protected createSession(args: NewSessionArgs<ClaudeSession>): ClaudeSession {
    const config =
      args.entry && this.registry ? this.registry.claudeConfig(args.entry) : this.agent;
    return new ClaudeSession(
      {
        key: args.key,
        providerId: args.providerId,
        model: args.model,
        effort: args.effort,
        system: args.system,
        tools: args.tools,
        history: args.history,
        config,
        onLimits: (m, l) => this.recordLimits(m, l),
      },
      args.onClose,
    );
  }

  /** Models come from the highest-priority enabled login. */
  private modelsConfig(): ClaudeConfig {
    const first = this.registry?.store.enabled("claude")[0];
    return first && this.registry ? this.registry.claudeConfig(first) : this.agent;
  }

  private async supportedModels(): Promise<ModelInfo[]> {
    if (this.models && Date.now() - this.models.at < MODEL_CACHE_MS) return this.models.list;
    try {
      const list = await probeModels(this.modelsConfig());
      this.models = { at: Date.now(), list };
      return list;
    } catch (error) {
      log.warn("could not list Claude models; using aliases", { error: String(error) });
      return FALLBACK_MODELS.map((value) => ({ value, displayName: value, description: "" }));
    }
  }
}
