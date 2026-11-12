import type { ClaudeConfig, CodexConfig } from "../config.ts";
import { log } from "../log.ts";
import { fetchClaudeUsage } from "./claude/usage.ts";
import { fetchCodexUsage } from "./codex/usage.ts";
import type { ProviderUsage } from "./usage.ts";
import type { ProviderEntry, ProviderStore, ProviderType } from "./store.ts";

const USAGE_CACHE_MS = 60_000;
/** How long to avoid a provider after a rate limit that did not say when it resets. */
const DEFAULT_COOLDOWN_MS = 5 * 60_000;

export type ProviderHealth = "ready" | "rate_limited" | "auth_failed" | "disabled";

export interface UsageCounters {
  requests: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  lastUsedAt: number | undefined;
}

interface Runtime {
  counters: UsageCounters;
  limitedUntil: number | undefined;
  limitReason: string | undefined;
  authFailed: string | undefined;
  usage: ProviderUsage | undefined;
  inflight: Promise<ProviderUsage> | undefined;
}

export interface ProviderStatus {
  entry: ProviderEntry;
  health: ProviderHealth;
  /** Why the provider is being avoided, when it is. */
  detail: string | undefined;
  limitedUntil: number | undefined;
  counters: UsageCounters;
}

export type FailureKind = "rate_limit" | "auth";

/** Reads one login's account and plan usage. */
export type UsageSource = (entry: ProviderEntry) => Promise<ProviderUsage>;

/** The base settings each provider type's logins inherit. */
export interface BaseConfigs {
  claude: ClaudeConfig;
  codex: CodexConfig;
}

const PRODUCT: Record<ProviderType, string> = { claude: "Claude Code", codex: "Codex" };

export interface TurnTokens {
  prompt: number;
  completion: number;
  cached: number;
}

/**
 * Runtime view over the configured providers: which one serves the next
 * request, which are cooling down, and what each has used.
 */
export class ProviderRegistry {
  readonly store: ProviderStore;
  private readonly base: BaseConfigs;
  private readonly fetchUsage: UsageSource;
  private readonly runtime = new Map<string, Runtime>();
  private readonly now: () => number;

  constructor(
    store: ProviderStore,
    base: BaseConfigs,
    options: { fetchUsage?: UsageSource; now?: () => number } = {},
  ) {
    this.store = store;
    this.base = base;
    this.fetchUsage = options.fetchUsage ?? ((entry) => this.readUsage(entry));
    this.now = options.now ?? Date.now;
  }

  /** Claude Code settings for one provider: the shared config plus its own login directory. */
  claudeConfig(entry: ProviderEntry): ClaudeConfig {
    const { claude } = this.base;
    if (entry.configDir === undefined) return claude;
    return { ...claude, env: { ...claude.env, CLAUDE_CONFIG_DIR: entry.configDir } };
  }

  /** Codex settings for one provider: the shared config plus its own CODEX_HOME. */
  codexConfig(entry: ProviderEntry): CodexConfig {
    const { codex } = this.base;
    if (entry.configDir === undefined) return codex;
    return { ...codex, env: { ...codex.env, CODEX_HOME: entry.configDir } };
  }

  /**
   * The login that should serve a new conversation: the first enabled one in
   * priority order that is not cooling down. When every candidate is cooling
   * down, the one whose limit lifts soonest, so a request still gets a real answer.
   * `type` limits the choice to logins of one provider type.
   */
  pick(exclude: ReadonlySet<string> = new Set(), type?: ProviderType): ProviderEntry | undefined {
    const candidates = this.store.enabled(type).filter((e) => !exclude.has(e.id));
    const ready = candidates.find((e) => this.health(e) === "ready");
    if (ready) return ready;
    return candidates
      .filter((e) => this.health(e) === "rate_limited")
      .toSorted((a, b) => (this.rt(a.id).limitedUntil ?? 0) - (this.rt(b.id).limitedUntil ?? 0))[0];
  }

  status(): ProviderStatus[] {
    return this.store.list().map((entry) => this.statusOf(entry));
  }

  statusOf(entry: ProviderEntry): ProviderStatus {
    const rt = this.rt(entry.id);
    const health = this.health(entry);
    return {
      entry,
      health,
      detail: health === "auth_failed" ? rt.authFailed : rt.limitReason,
      limitedUntil: health === "rate_limited" ? rt.limitedUntil : undefined,
      counters: { ...rt.counters },
    };
  }

  markFailed(id: string, kind: FailureKind, reason: string, resetsAt?: number): void {
    const rt = this.rt(id);
    rt.counters.errors++;
    if (kind === "auth") {
      rt.authFailed = reason;
    } else {
      rt.limitedUntil = resetsAt ?? this.now() + DEFAULT_COOLDOWN_MS;
      rt.limitReason = reason;
    }
    log.warn("provider unavailable", { provider: id, kind, reason });
  }

  /** Clears cooldowns, e.g. after the user re-logs in and verifies. */
  markHealthy(id: string): void {
    const rt = this.rt(id);
    rt.limitedUntil = undefined;
    rt.limitReason = undefined;
    rt.authFailed = undefined;
  }

  recordTurn(id: string, tokens: TurnTokens | undefined): void {
    const c = this.rt(id).counters;
    c.requests++;
    c.lastUsedAt = this.now();
    if (tokens) {
      c.inputTokens += tokens.prompt;
      c.outputTokens += tokens.completion;
      c.cachedTokens += tokens.cached;
    }
  }

  /** Account and plan usage for one provider; cached briefly because it spawns a process. */
  async usage(id: string, options: { force?: boolean } = {}): Promise<ProviderUsage> {
    const entry = this.store.get(id);
    if (!entry) throw new Error(`No provider with id "${id}"`);
    const rt = this.rt(id);
    if (!options.force && rt.usage && this.now() - rt.usage.fetchedAt < USAGE_CACHE_MS) {
      return rt.usage;
    }
    rt.inflight ??= this.fetchUsage(entry).finally(() => {
      rt.inflight = undefined;
    });
    const usage = await rt.inflight;
    rt.usage = usage;
    return usage;
  }

  /** Last usage read without triggering a fetch. */
  cachedUsage(id: string): ProviderUsage | undefined {
    return this.rt(id).usage;
  }

  /** Re-reads the account; a provider that answers with an account is logged in. */
  async verify(id: string): Promise<{ ok: boolean; message: string; usage: ProviderUsage }> {
    const usage = await this.usage(id, { force: true });
    if (usage.account === undefined) {
      const product = PRODUCT[this.store.get(id)?.type ?? "claude"];
      return { ok: false, message: usage.error ?? `${product} did not report an account.`, usage };
    }
    const who = usage.account.email ?? usage.account.organization;
    if (who === undefined && usage.account.plan === undefined && !usage.account.billedToApi) {
      return {
        ok: false,
        message: "Not logged in. Run the login command, then verify again.",
        usage,
      };
    }
    this.markHealthy(id);
    const plan = usage.account.plan ? ` (${usage.account.plan})` : "";
    return { ok: true, message: `Logged in${who ? ` as ${who}` : ""}${plan}.`, usage };
  }

  private readUsage(entry: ProviderEntry): Promise<ProviderUsage> {
    return entry.type === "codex"
      ? fetchCodexUsage(this.codexConfig(entry))
      : fetchClaudeUsage(this.claudeConfig(entry));
  }

  private health(entry: ProviderEntry): ProviderHealth {
    if (!entry.enabled) return "disabled";
    const rt = this.rt(entry.id);
    if (rt.authFailed !== undefined) return "auth_failed";
    if (rt.limitedUntil !== undefined) {
      if (rt.limitedUntil > this.now()) return "rate_limited";
      rt.limitedUntil = undefined;
      rt.limitReason = undefined;
    }
    return "ready";
  }

  private rt(id: string): Runtime {
    let rt = this.runtime.get(id);
    if (!rt) {
      rt = {
        counters: {
          requests: 0,
          errors: 0,
          inputTokens: 0,
          outputTokens: 0,
          cachedTokens: 0,
          lastUsedAt: undefined,
        },
        limitedUntil: undefined,
        limitReason: undefined,
        authFailed: undefined,
        usage: undefined,
        inflight: undefined,
      };
      this.runtime.set(id, rt);
    }
    return rt;
  }
}
